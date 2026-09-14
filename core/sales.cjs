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

  return Object.freeze({
    invoiceDetail
  });
}

module.exports = { createSalesCore };
