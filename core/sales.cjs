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

  return Object.freeze({
    invoiceDetail,
    invoiceNew,
    invoiceAddItem,
    invoiceSetDiscount
  });
}

module.exports = { createSalesCore };
