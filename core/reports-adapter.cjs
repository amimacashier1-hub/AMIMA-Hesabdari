'use strict';

/**
 * Reports Adapter
 *
 * مرز بین Electron IPC و Reports Business Core.
 * هیچ منطق تجاری در این فایل وجود ندارد.
 */

function createReportsAdapter(reportsCore) {
  if (!reportsCore || typeof reportsCore.getSummary !== 'function') {
    throw new Error('Reports Adapter requires Reports Core');
  }

  if (typeof reportsCore.getRecent !== 'function') {
    throw new Error('Reports Adapter requires getRecent()');
  }

  return Object.freeze({
    getSummary() {
      return reportsCore.getSummary();
    },

    getRecent() {
      return reportsCore.getRecent();
    }
  });
}

module.exports = {
  createReportsAdapter
};
