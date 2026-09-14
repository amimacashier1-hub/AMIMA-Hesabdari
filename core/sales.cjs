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

  return Object.freeze({
    invoiceDetail,
    invoiceNew
  });
}

module.exports = { createSalesCore };
