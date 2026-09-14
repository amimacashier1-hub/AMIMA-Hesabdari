'use strict';

/**
 * Business Core - Reports
 *
 * منطق گزارش‌ها از reports:summary و reports:recent
 * بدون تغییر رفتاری استخراج شده است.
 */

function createReportsCore(ctx) {
  if (!ctx || typeof ctx.rows !== 'function') {
    throw new Error('Reports Core requires rows()');
  }

  if (typeof ctx.money !== 'function') {
    throw new Error('Reports Core requires money()');
  }

  if (typeof ctx.localDateKey !== 'function') {
    throw new Error('Reports Core requires localDateKey()');
  }

  if (typeof ctx.localMonthKey !== 'function') {
    throw new Error('Reports Core requires localMonthKey()');
  }

  return Object.freeze({
    getSummary() {
      const day = ctx.localDateKey();
      const month = ctx.localMonthKey();

      const today = ctx.rows(
        "SELECT COALESCE(SUM(total),0) sales, COUNT(*) invoices FROM invoices WHERE status IN ('PAID','PARTIALLY_RETURNED','RETURNED') AND date(closed_at,'localtime')=?",
        [day]
      )[0];

      const m = ctx.rows(
        "SELECT COALESCE(SUM(total),0) sales, COUNT(*) invoices FROM invoices WHERE status IN ('PAID','PARTIALLY_RETURNED','RETURNED') AND strftime('%Y-%m',closed_at,'localtime')=?",
        [month]
      )[0];

      const salesToday = Number(
        ctx.rows(
          "SELECT COALESCE(SUM(total),0) v FROM invoices WHERE status IN ('PAID','PARTIALLY_RETURNED','RETURNED') AND date(closed_at,'localtime')=?",
          [day]
        )[0]?.v || 0
      );

      const returnsToday = Number(
        ctx.rows(
          "SELECT COALESCE(SUM(refund_total),0) v FROM sales_returns WHERE date(created_at,'localtime')=?",
          [day]
        )[0]?.v || 0
      );

      const cogsToday = Number(
        ctx.rows(
          "SELECT COALESCE(-SUM(total_cost),0) v FROM stock_movements WHERE movement_type='SALE' AND date(created_at,'localtime')=?",
          [day]
        )[0]?.v || 0
      );

      const returnCogsToday = Number(
        ctx.rows(
          "SELECT COALESCE(SUM(total_cost),0) v FROM stock_movements WHERE movement_type='RETURN_IN' AND invoice_id IS NOT NULL AND date(created_at,'localtime')=?",
          [day]
        )[0]?.v || 0
      );

      const netSales = ctx.money(salesToday - returnsToday);
      const netCogs = ctx.money(cogsToday - returnCogsToday);

      const profit = {
        salesGross: ctx.money(salesToday),
        returns: ctx.money(returnsToday),
        salesNet: netSales,
        cogs: netCogs,
        profit: ctx.money(netSales - netCogs)
      };

      const best = ctx.rows(`
        SELECT product_name, unit, SUM(quantity) quantity, SUM(amount) amount
        FROM invoice_items ii JOIN invoices i ON i.id=ii.invoice_id
        WHERE i.status IN ('PAID','PARTIALLY_RETURNED','RETURNED')
          AND strftime('%Y-%m',i.closed_at,'localtime')=?
        GROUP BY product_id,product_name,unit
        ORDER BY quantity DESC
        LIMIT 10
      `, [month]);

      const payments = ctx.rows(
        "SELECT method, COALESCE(SUM(amount),0) amount, COUNT(*) count FROM payments p JOIN invoices i ON i.id=p.invoice_id WHERE i.status IN ('PAID','PARTIALLY_RETURNED','RETURNED') AND date(i.closed_at,'localtime')=? GROUP BY method ORDER BY amount DESC",
        [day]
      );

      const stockValue = ctx.rows(
        "SELECT COALESCE(SUM(v.value),0) value FROM (SELECT product_id,COALESCE(SUM(total_cost),0) value FROM stock_movements GROUP BY product_id HAVING COALESCE(SUM(quantity),0)>0) v"
      )[0];

      return {
        today,
        month: m,
        profit,
        best,
        payments,
        stockValue,
        valuationMethod: 'MOVING_AVERAGE'
      };
    },

    getRecent(limit = 50) {
      const safeLimit = Math.min(50, Math.max(1, Number(limit) || 50));

      return ctx.rows(
        "SELECT id,invoice_no,total,payment_method,closed_at FROM invoices WHERE status='PAID' ORDER BY closed_at DESC LIMIT ?",
        [safeLimit]
      );
    }
  });
}

module.exports = {
  createReportsCore
};
