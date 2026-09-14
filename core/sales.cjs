'use strict';

function createSalesCore(ctx) {
  if (!ctx || typeof ctx.rows !== 'function') {
    throw new Error('Sales Core requires rows()');
  }

  function invoiceDetail(invoiceId) {
    const inv = ctx.rows(
      "SELECT * FROM invoices WHERE id=?",
      [invoiceId]
    )[0];

    if (!inv) return null;

    const items = ctx.rows(
      "SELECT * FROM invoice_items WHERE invoice_id=? ORDER BY rowid",
      [invoiceId]
    );

    return { ...inv, items };
  }

  function invoicePayments(invoiceId) {
    return ctx.rows(
      "SELECT * FROM payments WHERE invoice_id=? ORDER BY created_at",
      [invoiceId]
    );
  }

  function invoiceNew() {
    return ctx.withTransaction(() => {
      const now = new Date().toISOString();
      const id = ctx.newId('inv');
      const no = ctx.nextInvoiceNo();

      ctx.db.run(
        "INSERT INTO invoices(id,invoice_no,status,created_at,updated_at) VALUES(?,?,?,?,?)",
        [id,no,'OPEN',now,now]
      );

      ctx.queueSync('invoice', id);

      return invoiceDetail(id);
    });
  }


  function invoiceAddItem({invoiceId, productId, quantity, unitPrice, manualPrice}) {
    const inv = ctx.rows(
      "SELECT id,status FROM invoices WHERE id=?",
      [invoiceId]
    )[0];

    if (!inv || inv.status !== 'OPEN') {
      throw new Error('فاکتور باز پیدا نشد');
    }

    const p = ctx.rows(
      "SELECT * FROM products WHERE id=? AND active=1",
      [productId]
    )[0];

    if (!p) throw new Error('کالا پیدا نشد');

    const qty = Number(quantity);
    if (!(qty > 0)) throw new Error('مقدار نامعتبر است');

    const manual = !!manualPrice;
    const requestedPrice = Number(unitPrice);

    if (
      manual &&
      (!Number.isFinite(requestedPrice) || requestedPrice < 0)
    ) {
      throw new Error('قیمت فروش نامعتبر است');
    }

    return ctx.withTransaction(() => {
      const existingQty = ctx.rows(
        "SELECT COALESCE(SUM(quantity),0) qty FROM invoice_items WHERE invoice_id=? AND product_id=?",
        [invoiceId, productId]
      )[0];

      const requestedTotal =
        Number(existingQty?.qty || 0) + qty;

      if (requestedTotal > ctx.ledgerStock(productId)) {
        throw new Error('موجودی کافی نیست');
      }

      const existingItem = ctx.rows(
        "SELECT * FROM invoice_items WHERE invoice_id=? AND product_id=? LIMIT 1",
        [invoiceId, productId]
      )[0];

      if (existingItem) {
        ctx.db.run(
          "UPDATE invoice_items SET quantity=quantity+? WHERE id=?",
          [qty, existingItem.id]
        );

        if (manual) {
          const price = ctx.money(requestedPrice);

          ctx.db.run(
            "UPDATE invoice_items SET unit_price=?, amount=ROUND(quantity * ?,0), tier_order=-1 WHERE id=?",
            [price, price, existingItem.id]
          );
        } else {
          ctx.repriceInvoiceProduct(invoiceId, productId);
        }
      } else {
        const price = manual
          ? ctx.money(requestedPrice)
          : ctx.money(p.sale_price_per_unit);

        ctx.db.run(
          `INSERT INTO invoice_items(id,invoice_id,product_id,product_name,quantity,unit,unit_price,purchase_unit_price,amount,tier_order) VALUES(?,?,?,?,?,?,?,?,?,?)`,
          [
            ctx.newId('item'),
            invoiceId,
            productId,
            p.name,
            qty,
            p.unit,
            price,
            p.purchase_price,
            ctx.money(qty * price),
            manual ? -1 : null
          ]
        );

        if (!manual) {
          ctx.repriceInvoiceProduct(invoiceId, productId);
        }
      }

      ctx.recalcInvoice(invoiceId);
      ctx.queueSync('invoice', invoiceId);

      return invoiceDetail(invoiceId);
    });
  }

  function invoiceSetDiscount({invoiceId, discount, discountPercent}) {
    const inv = ctx.rows(
      "SELECT status,subtotal FROM invoices WHERE id=?",
      [invoiceId]
    )[0];

    if (!inv || inv.status !== 'OPEN') {
      throw new Error('فاکتور باز پیدا نشد');
    }

    let value;

    if (discountPercent !== undefined) {
      const pct = Number(discountPercent);

      if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
        throw new Error('درصد تخفیف باید بین صفر تا ۱۰۰ باشد');
      }

      value = ctx.money(Number(inv.subtotal || 0) * pct / 100);
    } else {
      value = ctx.assertFiniteNonNegative(discount, 'تخفیف');
    }

    if (value > Number(inv.subtotal)) {
      throw new Error('تخفیف نمی‌تواند از جمع فاکتور بیشتر باشد');
    }

    return ctx.withTransaction(() => {
      ctx.db.run(
        "UPDATE invoices SET discount=? WHERE id=?",
        [ctx.money(value), invoiceId]
      );

      ctx.recalcInvoice(invoiceId);
      ctx.queueSync('invoice', invoiceId);

      return invoiceDetail(invoiceId);
    });
  }


  function invoiceRemoveItem({ invoiceId, itemId }) {
    const inv = ctx.rows(
      "SELECT status FROM invoices WHERE id=?",
      [invoiceId]
    )[0];

    if (!inv || inv.status !== 'OPEN') {
      throw new Error('فاکتور باز پیدا نشد');
    }

    return ctx.withTransaction(() => {
      const oldItem = ctx.rows(
        "SELECT * FROM invoice_items WHERE id=? AND invoice_id=?",
        [itemId, invoiceId]
      )[0];

      if (!oldItem) {
        throw new Error('قلم فاکتور پیدا نشد');
      }

      const result = ctx.db.run(
        "DELETE FROM invoice_items WHERE id=? AND invoice_id=?",
        [itemId, invoiceId]
      );

      if (!result.changes) {
        throw new Error('قلم فاکتور پیدا نشد');
      }

      if (oldItem.product_id) {
        ctx.repriceInvoiceProduct(invoiceId, oldItem.product_id);
      }

      ctx.recalcInvoice(invoiceId);

      ctx.queueSync(
        'invoice_item',
        itemId,
        'DELETE',
        oldItem
      );

      ctx.queueSync('invoice', invoiceId);

      ctx.auditLog(
        'INVOICE_ITEM_REMOVE',
        'INVOICE_ITEM',
        itemId,
        {
          invoiceId,
          productId: oldItem.product_id,
          quantity: oldItem.quantity
        },
        'INVOICE',
        invoiceId,
        new Date().toISOString()
      );

      return invoiceDetail(invoiceId);
    });
  }

  function invoicePay({ invoiceId, payments, method }) {

  const inv = ctx.rows("SELECT * FROM invoices WHERE id=? AND status='OPEN'",[invoiceId])[0];
  if (!inv) throw new Error('فاکتور باز پیدا نشد');
  const items = ctx.rows("SELECT * FROM invoice_items WHERE invoice_id=?",[invoiceId]);
  if (!items.length) throw new Error('فاکتور خالی است');
  const list = Array.isArray(payments) ? payments : [{method,amount:inv.total}];
  const normalized = list.map(x => ({method:String(x.method||'').toUpperCase(), amount:ctx.money(ctx.assertFiniteNonNegative(x.amount,'مبلغ پرداخت'))})).filter(x=>x.amount>0);
  const allowed = new Set(['CASH','CARD','ACCOUNT']);
  if (!normalized.length || normalized.some(x=>!allowed.has(x.method))) throw new Error('روش پرداخت نامعتبر است');
  const paidTotal = normalized.reduce((a,x)=>a+x.amount,0);
  if (paidTotal !== ctx.money(inv.total)) throw new Error('مجموع پرداخت‌ها باید دقیقاً برابر مبلغ فاکتور باشد');
  const accountPay = normalized.filter(x=>x.method==='ACCOUNT').reduce((a,x)=>a+x.amount,0);
  if (accountPay > 0 && !inv.customer_id) throw new Error('برای فروش اعتباری باید مشتری انتخاب شود');

  return ctx.withTransaction(() => {
    for (const item of items) {
      const p = ctx.rows("SELECT stock FROM products WHERE id=? AND active=1",[item.product_id])[0];
      if (!p || ctx.ledgerStock(item.product_id) < Number(item.quantity)) throw new Error(`موجودی ${item.product_name} کافی نیست`);
    }
    const now = new Date().toISOString();
    const reg = ctx.rows("SELECT * FROM cash_registers WHERE status='OPEN' ORDER BY opened_at DESC LIMIT 1")[0];
    if (!reg && normalized.some(x=>x.method==='CASH')) throw new Error('برای دریافت نقدی ابتدا صندوق را باز کنید');
    for (const item of items) {
      const saleCost = ctx.movementCost(item.product_id, 'SALE', item.quantity, ctx.movingAverageCost(item.product_id));
      const movementId = ctx.newId('mov');
      ctx.db.run("INSERT INTO stock_movements(id,product_id,invoice_id,movement_type,quantity,unit_cost,total_cost,cost_method,created_at,note) VALUES(?,?,?,?,?,?,?,?,?,?)",
        [movementId,item.product_id,invoiceId,'SALE',-Number(item.quantity),saleCost.unitCost,-saleCost.totalCost,'MOVING_AVERAGE',now,'فروش فاکتور']);
      ctx.syncProductStockFromLedger(item.product_id, now);
      ctx.queueSync('stock_movement', movementId);
      ctx.queueSync('product', item.product_id);
    }
    ctx.db.run("UPDATE invoices SET status='PAID',payment_method=?,closed_at=?,updated_at=? WHERE id=? AND status='OPEN'",
      [normalized.map(x=>x.method).join('+'),now,now,invoiceId]);
    ctx.queueSync('invoice', invoiceId);
    const journalLines=[];
    for (const x of normalized) {
      const paymentId = ctx.newId('pay');
      ctx.db.run("INSERT INTO payments(id,invoice_id,method,amount,created_at) VALUES(?,?,?,?,?)",
        [paymentId,invoiceId,x.method,x.amount,now]);
      ctx.queueSync('payment', paymentId);
      if (x.method==='ACCOUNT') { ctx.postCustomerLedger(inv.customer_id,'DEBIT',x.amount,'SALE_CREDIT','PAYMENT',paymentId,`فروش اعتباری فاکتور ${inv.invoice_no}`,now); journalLines.push({accountCode:'AR',accountName:'حساب‌های دریافتنی مشتریان',debit:x.amount,credit:0,note:`فاکتور ${inv.invoice_no}`}); }
      if (x.method==='CASH') { ctx.insertCashMovement({registerId:reg.id,type:'SALE',amount:x.amount,direction:'IN',category:'SALE',note:`فروش فاکتور ${inv.invoice_no}`,referenceType:'INVOICE',referenceId:invoiceId,createdAt:now}); journalLines.push({accountCode:'CASH',accountName:'صندوق نقدی',debit:x.amount,credit:0,note:`فاکتور ${inv.invoice_no}`}); }
      if (x.method==='CARD') journalLines.push({accountCode:'BANK',accountName:'بانک / کارتخوان',debit:x.amount,credit:0,note:`فاکتور ${inv.invoice_no}`});
    }
    journalLines.push({accountCode:'SALES',accountName:'فروش',debit:0,credit:ctx.money(inv.total),note:`فاکتور ${inv.invoice_no}`});
    ctx.postJournalOnce('SALE','SALE',`فروش فاکتور ${inv.invoice_no}`,journalLines,'INVOICE',invoiceId,now);
    // COGS must be calculated from ALL SALE movements created for this invoice.
    // A product can be added/merged multiple times in one invoice; selecting only
    // the latest movement would understate COGS in that case.
    const saleCogs=ctx.money(Number(ctx.rows("SELECT COALESCE(-SUM(total_cost),0) v FROM stock_movements WHERE invoice_id=? AND movement_type='SALE'",[invoiceId])[0]?.v||0));
    if(saleCogs>0) ctx.postJournalOnce('COGS_SALE','COGS_SALE',`بهای تمام‌شده فاکتور ${inv.invoice_no}`,[{accountCode:'COGS',accountName:'بهای تمام‌شده کالای فروش‌رفته',debit:saleCogs,credit:0,note:`فاکتور ${inv.invoice_no}`},{accountCode:'INVENTORY',accountName:'موجودی کالا',debit:0,credit:saleCogs,note:`فاکتور ${inv.invoice_no}`}],'INVOICE',invoiceId,now);
    ctx.auditLog('SALE_COMPLETED','INVOICE',invoiceId,{invoiceNo:inv.invoice_no,total:inv.total,paymentMethods:normalized},'INVOICE',invoiceId,now);
    return ctx.invoiceDetail(invoiceId);
  });
  }

  return Object.freeze({
    invoiceDetail,
    invoicePayments,
    invoiceNew,
    invoiceAddItem,
    invoiceSetDiscount,
    invoiceRemoveItem,
    invoicePay
  });
}

module.exports = { createSalesCore };
