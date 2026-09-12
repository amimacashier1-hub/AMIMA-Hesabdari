const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('hesabdari', {
  auth: { login: (data) => ipcRenderer.invoke('auth:login', data), logout: () => ipcRenderer.invoke('auth:logout'), current: () => ipcRenderer.invoke('auth:current') },
  users: { list: () => ipcRenderer.invoke('users:list'), create: (data) => ipcRenderer.invoke('users:create', data), setPassword: (data) => ipcRenderer.invoke('users:set-password', data), setActive: (data) => ipcRenderer.invoke('users:set-active', data) },
  dashboard: () => ipcRenderer.invoke('app:get-dashboard'),
  categories: {
    list: () => ipcRenderer.invoke('categories:list'),
    save: (data) => ipcRenderer.invoke('categories:save', data),
    archive: (id) => ipcRenderer.invoke('categories:archive', id)
  },
  products: {
    list: () => ipcRenderer.invoke('products:list'),
    search: (q) => ipcRenderer.invoke('products:search', q),
    save: (p) => ipcRenderer.invoke('products:save', p),
    tiers: (id) => ipcRenderer.invoke('products:tiers', id),
    archive: (id) => ipcRenderer.invoke('products:archive', id),
    bulkReprice: (data) => ipcRenderer.invoke('products:bulk-reprice', data),
    priceHistory: (opts) => ipcRenderer.invoke('products:price-history', opts || {})
  },
  invoices: {
    listOpen: () => ipcRenderer.invoke('invoices:list-open'),
    new: () => ipcRenderer.invoke('invoice:new'),
    get: (id) => ipcRenderer.invoke('invoice:get', id),
    addItem: (data) => ipcRenderer.invoke('invoice:add-item', data),
    removeItem: (data) => ipcRenderer.invoke('invoice:remove-item', data),
    discount: (data) => ipcRenderer.invoke('invoice:set-discount', data),
    pay: (data) => ipcRenderer.invoke('invoice:pay', data),
    payments: (id) => ipcRenderer.invoke('invoice:payments', id),
    returns: (id) => ipcRenderer.invoke('invoice:returns', id),
    return: (data) => ipcRenderer.invoke('invoice:return', data),
    setCustomer: (data) => ipcRenderer.invoke('invoice:set-customer', data),
    cancel: (id) => ipcRenderer.invoke('invoice:cancel', id)
  },
  customers: { list: () => ipcRenderer.invoke('customers:list'), save: (data) => ipcRenderer.invoke('customers:save', data), ledger: (id) => ipcRenderer.invoke('customers:ledger', id), summary: (id) => ipcRenderer.invoke('customers:summary', id), payment: (data) => ipcRenderer.invoke('customers:payment', data), settle: (data) => ipcRenderer.invoke('customers:settle', data) },
  suppliers: { list: () => ipcRenderer.invoke('suppliers:list'), save: (data) => ipcRenderer.invoke('suppliers:save', data), ledger: (id) => ipcRenderer.invoke('suppliers:ledger', id), summary: (id) => ipcRenderer.invoke('suppliers:summary', id) },
  purchase: { listOpen: () => ipcRenderer.invoke('purchase:list-open'), new: (data) => ipcRenderer.invoke('purchase:new', data), get: (id) => ipcRenderer.invoke('purchase:get', id), addItem: (data) => ipcRenderer.invoke('purchase:add-item', data), removeItem: (data) => ipcRenderer.invoke('purchase:remove-item', data), discount: (data) => ipcRenderer.invoke('purchase:set-discount', data), pay: (data) => ipcRenderer.invoke('purchase:pay', data), payments: (id) => ipcRenderer.invoke('purchase:payments', id) },
  cash: {
    status: () => ipcRenderer.invoke('cash:status'),
    open: (data) => ipcRenderer.invoke('cash:open', data),
    move: (data) => ipcRenderer.invoke('cash:move', data),
    close: (data) => ipcRenderer.invoke('cash:close', data),
    movements: (id) => ipcRenderer.invoke('cash:movements', id)
  },
  receipt: { print: (id) => ipcRenderer.invoke('receipt:print', id) },
  stock: {
    adjust: (data) => ipcRenderer.invoke('stock:adjust', data),
    movements: (id) => ipcRenderer.invoke('stock:movements', id)
  },
  reports: { summary: () => ipcRenderer.invoke('reports:summary'), recent: () => ipcRenderer.invoke('reports:recent') },
  sync: {
    config: () => ipcRenderer.invoke('sync:config'),
    setConfig: (data) => ipcRenderer.invoke('sync:set-config', data),
    status: () => ipcRenderer.invoke('sync:status'),
    preview: () => ipcRenderer.invoke('sync:preview'),
    run: () => ipcRenderer.invoke('sync:run'),
    conflicts: () => ipcRenderer.invoke('sync:conflicts'),
    resolve: (data) => ipcRenderer.invoke('sync:resolve', data)
  },
  accounting: {
    entries: (limit) => ipcRenderer.invoke('accounting:entries', limit),
    entry: (id) => ipcRenderer.invoke('accounting:entry', id),
    trialBalance: () => ipcRenderer.invoke('accounting:trial-balance')
  },
  audit: {
    list: (opts) => ipcRenderer.invoke('audit:list', opts || {}),
    summary: () => ipcRenderer.invoke('audit:summary')
  },
  integrity: { full: () => ipcRenderer.invoke('integrity:full') },
  backup: {
    create: () => ipcRenderer.invoke('backup:create'),
    createAuto: () => ipcRenderer.invoke('backup:create-auto'),
    restore: () => ipcRenderer.invoke('backup:restore'),
    verify: (source) => ipcRenderer.invoke('backup:verify', source),
    health: () => ipcRenderer.invoke('backup:health'),
    list: () => ipcRenderer.invoke('backup:list'),
    settings: () => ipcRenderer.invoke('backup:settings'),
    setSettings: (data) => ipcRenderer.invoke('backup:set-settings', data)
  }
});
