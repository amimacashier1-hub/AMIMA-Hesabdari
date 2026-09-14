'use strict';

function createDashboardCore(ctx) {
  if (!ctx || typeof ctx.rows !== 'function') {
    throw new Error('Dashboard Core requires rows()');
  }

  return Object.freeze({
    getSummary() {
      const products = ctx.rows(
        'SELECT COUNT(*) AS count FROM products WHERE active=1'
      )[0];

      const invoices = ctx.rows(
        'SELECT COUNT(*) AS count FROM invoices'
      )[0];

      return {
        productsCount: Number(products?.count || 0),
        invoicesCount: Number(invoices?.count || 0)
      };
    }
  });
}

module.exports = {
  createDashboardCore
};
