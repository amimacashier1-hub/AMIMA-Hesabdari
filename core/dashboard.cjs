'use strict';

/**
 * Business Core - Dashboard
 *
 * منطق این ماژول از app:get-dashboard فعلی استخراج شده است.
 * هیچ تغییر رفتاری در Queryهای اصلی ایجاد نشده است.
 */

function createDashboardCore(ctx) {
  if (!ctx || typeof ctx.rows !== 'function') {
    throw new Error('Dashboard Core requires rows()');
  }

  if (typeof ctx.localDateKey !== 'function') {
    throw new Error('Dashboard Core requires localDateKey()');
  }

  if (typeof ctx.localMonthKey !== 'function') {
    throw new Error('Dashboard Core requires localMonthKey()');
  }

  return Object.freeze({
    getSummary() {
      const today = ctx.localDateKey();

      const salesToday = ctx.rows(
        "SELECT COALESCE(SUM(total),0) total, COUNT(*) count FROM invoices WHERE status='PAID' AND date(closed_at,'localtime')=?",
        [today]
      )[0];

      const month = ctx.localMonthKey();

      const salesMonth = ctx.rows(
        "SELECT COALESCE(SUM(total),0) total FROM invoices WHERE status='PAID' AND strftime('%Y-%m',closed_at,'localtime')=?",
        [month]
      )[0];

      const best = ctx.rows(`
        SELECT product_id, product_name, SUM(quantity) qty, SUM(amount) amount
        FROM invoice_items ii JOIN invoices i ON i.id=ii.invoice_id
        WHERE i.status='PAID' AND strftime('%Y-%m',i.closed_at,'localtime')=?
        GROUP BY product_id, product_name
        ORDER BY qty DESC
        LIMIT 5
      `, [month]);

      const low = ctx.rows(
        "SELECT * FROM products WHERE active=1 AND stock <= min_stock ORDER BY stock ASC LIMIT 8"
      );

      const open = ctx.rows(
        "SELECT * FROM invoices WHERE status='OPEN' ORDER BY invoice_no"
      );

      return {
        salesToday,
        salesMonth,
        best,
        low,
        open
      };
    }
  });
}

module.exports = {
  createDashboardCore
};
