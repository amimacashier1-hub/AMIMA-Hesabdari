'use strict';

/**
 * Dashboard Adapter
 *
 * مرز بین Electron IPC و Business Core.
 * هیچ منطق تجاری جدیدی در این فایل وجود ندارد.
 */

function createDashboardAdapter(dashboardCore) {
  if (!dashboardCore || typeof dashboardCore.getSummary !== 'function') {
    throw new Error('Dashboard Adapter requires Dashboard Core');
  }

  return Object.freeze({
    getSummary() {
      return dashboardCore.getSummary();
    }
  });
}

module.exports = {
  createDashboardAdapter
};
