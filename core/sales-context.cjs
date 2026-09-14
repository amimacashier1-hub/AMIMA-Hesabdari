'use strict';

function createSalesContext(deps) {
  const required = [
    'db',
    'rows',
    'money',
    'newId',
    'withTransaction',
    'invoiceDetail',
    'nextInvoiceNo',
    'ledgerStock',
    'movingAverageCost',
    'movementCost',
    'syncProductStockFromLedger',
    'tierFor',
    'repriceInvoiceProduct',
    'recalcInvoice',
    'assertFiniteNonNegative',
    'queueSync',
    'auditLog',
    'postJournal',
    'postJournalOnce',
    'insertCashMovement'
  ];

  for (const name of required) {
    if (typeof deps[name] === 'undefined') {
      throw new Error(`Sales Context missing dependency: ${name}`);
    }
  }

  return Object.freeze({
    db: deps.db,
    rows: deps.rows,
    money: deps.money,
    newId: deps.newId,
    withTransaction: deps.withTransaction,

    invoiceDetail: deps.invoiceDetail,
    nextInvoiceNo: deps.nextInvoiceNo,

    ledgerStock: deps.ledgerStock,
    movingAverageCost: deps.movingAverageCost,
    movementCost: deps.movementCost,
    syncProductStockFromLedger: deps.syncProductStockFromLedger,

    tierFor: deps.tierFor,
    repriceInvoiceProduct: deps.repriceInvoiceProduct,
    recalcInvoice: deps.recalcInvoice,
    assertFiniteNonNegative: deps.assertFiniteNonNegative,

    queueSync: deps.queueSync,
    auditLog: deps.auditLog,

    postJournal: deps.postJournal,
    postJournalOnce: deps.postJournalOnce,

    insertCashMovement: deps.insertCashMovement
  });
}

module.exports = { createSalesContext };
