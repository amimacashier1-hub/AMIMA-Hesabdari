'use strict';

/**
 * Business Core Context
 *
 * این فایل فقط قرارداد وابستگی‌های Core را مشخص می‌کند.
 * در این مرحله هیچ منطق مالی از main.cjs منتقل نمی‌شود.
 */

function createCoreContext(deps) {
  if (!deps || typeof deps !== 'object') {
    throw new Error('Core context dependencies are required');
  }

  const required = [
    'db',
    'rows',
    'money',
    'newId',
    'withTransaction'
  ];

  for (const name of required) {
    if (deps[name] == null) {
      throw new Error(`Missing Core dependency: ${name}`);
    }
  }

  return Object.freeze({
    db: deps.db,
    rows: deps.rows,
    money: deps.money,
    newId: deps.newId,
    withTransaction: deps.withTransaction,
    localDateKey: deps.localDateKey || (() => {
      throw new Error('localDateKey dependency is required');
    }),
    localMonthKey: deps.localMonthKey || (() => {
      throw new Error('localMonthKey dependency is required');
    }),

    currentActor: deps.currentActor || (() => ({
      id: 'system-migration',
      name: 'سیستم مهاجرت'
    })),

    auditLog: deps.auditLog || (() => {}),
    queueSync: deps.queueSync || (() => {}),
    insertCashMovement: deps.insertCashMovement || null,
    invoiceDetail: deps.invoiceDetail || null,
    ledgerStock: deps.ledgerStock || null,
    repriceInvoiceProduct: deps.repriceInvoiceProduct || null,
    recalcInvoice: deps.recalcInvoice || null
  });
}

module.exports = {
  createCoreContext
};
