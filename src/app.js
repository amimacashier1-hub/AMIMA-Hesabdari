let currentPage='dashboard', products=[], currentInvoice=null, openInvoices=[], selectedProductId=null, currentPurchase=null, suppliers=[], suggestionIndex=-1, qPriceManual=false, selectedPaymentMethod=null;
const $=id=>document.getElementById(id); const fmt=n=>Number(n||0).toLocaleString('fa-IR');
function toast(t){$('toast').textContent=t;$('toast').classList.add('show');setTimeout(()=>$('toast').classList.remove('show'),2200)}
function esc(s){return String(s??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[m]))}
function go(page){currentPage=page;document.querySelectorAll('.page').forEach(x=>x.classList.add('hidden'));$('page-'+page).classList.remove('hidden');document.querySelectorAll('#nav button').forEach(x=>x.classList.toggle('active',x.dataset.page===page));if(page==='dashboard')loadDashboard();if(page==='sales')loadSales();if(page==='products'){loadProducts().then(()=>{renderProducts();loadPriceHistory()})}if(page==='inventory')loadInventory();if(page==='purchases')loadPurchasePage();if(page==='reports')loadReports();if(page==='customers')loadCustomers();if(page==='cash')loadCash();if(page==='accounting')loadAccounting();if(page==='audit')loadAudit();if(page==='backup')loadBackup();if(page==='sync')loadSync()}
async function loadDashboard(){const d=await window.hesabdari.dashboard();$('todaySales').textContent=fmt(d.salesToday.total);$('todayInvoices').textContent=fmt(d.salesToday.count);$('monthSales').textContent=fmt(d.salesMonth.total);const r=await window.hesabdari.reports.summary();$('todayProfit').textContent=fmt(r.profit.profit);$('bestSellers').innerHTML=d.best.map((x,i)=>`<div class="best"><div class="icon">${['🌿','🍃','🫚','🌱','🪴'][i]}</div><b>${esc(x.product_name)}</b><small>${fmt(x.qty)} ${esc(x.unit||'واحد')}</small></div>`).join('')||'<p class="empty">هنوز فروشی ثبت نشده است.</p>';renderOpen(d.open);$('lowStock').innerHTML=d.low.length?`<table><thead><tr><th>کالا</th><th>موجودی</th><th>حداقل</th></tr></thead><tbody>${d.low.map(x=>`<tr><td>${esc(x.name)}</td><td class="low">${fmt(x.stock)} ${esc(x.unit)}</td><td>${fmt(x.min_stock)}</td></tr>`).join('')}</tbody></table>`:'<p class="empty">موجودی کم نداریم.</p>'}
function renderOpen(list){openInvoices=list||[];$('openInvoices').innerHTML=openInvoices.map(x=>`<button class="itab" onclick="openInvoice('${x.id}')"><b>فاکتور ${fmt(x.invoice_no)}</b><span>${fmt(x.total)} تومان</span></button>`).join('')||'<p class="empty">فاکتور بازی وجود ندارد.</p>'}
async function loadSales(){openInvoices=await window.hesabdari.invoices.listOpen();if(!currentInvoice&&openInvoices[0])currentInvoice=await window.hesabdari.invoices.get(openInvoices[0].id);if(!currentInvoice)currentInvoice=await window.hesabdari.invoices.new();renderSale()}
async function newInvoice(){currentInvoice=await window.hesabdari.invoices.new();go('sales')}
async function openInvoice(id){currentInvoice=await window.hesabdari.invoices.get(id);go('sales')}
async function renderSale(){
  openInvoices=await window.hesabdari.invoices.listOpen();
  $('saleTabs').innerHTML=openInvoices.map(x=>`<button class="itab ${currentInvoice&&x.id===currentInvoice.id?'active':''}" onclick="openInvoice('${x.id}')">فاکتور ${fmt(x.invoice_no)}</button>`).join('');
  const i=currentInvoice;
  const discountPct=i.subtotal>0?((Number(i.discount||0)/Number(i.subtotal))*100):0;
  selectedPaymentMethod=null;
  $('saleArea').innerHTML=`<div class="sale-layout"><div><div class="quick"><div class="quick-title"><div><h2>افزودن سریع کالا</h2><p>با Enter بین فیلدها جابه‌جا شوید؛ با ↑ و ↓ کالا را انتخاب کنید.</p></div><span class="kbd">ENTER</span></div><div class="quick-grid"><div class="field-wrap"><label>جستجوی کالا</label><input id="qName" placeholder="مثلاً گل گاوزبان" autocomplete="off"></div><div class="field-wrap"><label>مقدار</label><input id="qQty" type="number" step="0.1" min="0.1" placeholder="100"></div><div class="field-wrap"><label>واحد</label><input id="qUnit" value="—" readonly></div><div class="field-wrap"><label>قیمت فروش (تومان)</label><input id="qPrice" value="—" type="number" min="0" step="1"></div><button class="primary add-btn" id="addQuickBtn" onclick="addQuick()">افزودن به فاکتور</button></div><div id="suggestions" class="suggestions hidden"></div><div id="tierHint" class="tier-hint">ابتدا کالا و مقدار را وارد کنید.</div></div><div class="card"><div class="card-title"><div><h2>اقلام فاکتور ${fmt(i.invoice_no)}</h2><p>${i.items.length} قلم</p></div></div><div class="table-wrap"><table><thead><tr><th>کالا</th><th>مقدار</th><th>قیمت/واحد</th><th>مبلغ</th><th></th></tr></thead><tbody>${i.items.length?i.items.map(x=>`<tr><td><b>${esc(x.product_name)}</b></td><td>${fmt(x.quantity)} ${esc(x.unit)}</td><td>${fmt(x.unit_price)}</td><td><b>${fmt(x.amount)}</b></td><td><button class="danger" onclick="removeItem('${x.id}')">حذف</button></td></tr>`).join(''):'<tr><td colspan="5" class="empty-cell">کالایی اضافه نشده است.</td></tr>'}</tbody></table></div></div></div><div class="cart"><div class="cart-head"><span>فاکتور ${fmt(i.invoice_no)}</span><span class="live">● باز</span></div><div class="summary-line"><span>جمع</span><b>${fmt(i.subtotal)} تومان</b></div><div class="summary-line"><span>تخفیف (%)</span><input id="discount" type="number" min="0" max="100" step="0.01" value="${discountPct.toFixed(2)}"></div><div class="summary-line final"><span>مبلغ نهایی</span><b>${fmt(i.total)} تومان</b></div><div class="pay-label">مشتری (اختیاری)</div><div class="payrow"><select id="customerSelect" onchange="setCustomer(this.value)" style="width:100%"><option value="">مشتری متفرقه</option></select></div><div class="pay-label">روش پرداخت</div><div class="payrow payment-methods"><button id="payCashBtn" onclick="selectPayment('CASH')">نقدی</button><button id="payCardBtn" onclick="selectPayment('CARD')">کارت / اعتباری</button><button id="payAccountBtn" onclick="selectPayment('ACCOUNT')">نسیه</button></div><div id="paymentHint" class="tier-hint">یک روش پرداخت را انتخاب کنید.</div><div class="payrow"><button id="finalNoPrint" class="primary" disabled onclick="confirmPayment(false)">ثبت نهایی بدون چاپ رسید</button><button id="finalPrint" class="primary" disabled onclick="confirmPayment(true)">ثبت نهایی و چاپ رسید</button></div><button class="ghost" onclick="cancelCurrentInvoice()">لغو فاکتور باز</button></div></div>`;
  setupQuick();
  loadCustomersForInvoice();
  setupSaleKeyboard();
  $('discount').onchange=()=>setDiscount($('discount').value);
  $('discount').onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();setDiscount($('discount').value)}};
}

function suggestionItems(){return [...document.querySelectorAll('#suggestions .suggestion-item')]}
function highlightSuggestion(index){const items=suggestionItems();if(!items.length){suggestionIndex=-1;return}suggestionIndex=Math.max(0,Math.min(index,items.length-1));items.forEach((el,i)=>el.classList.toggle('active',i===suggestionIndex));items[suggestionIndex]?.scrollIntoView({block:'nearest'});}
async function chooseSuggestion(){const items=suggestionItems();if(!items.length)return false;const idx=suggestionIndex>=0?suggestionIndex:0;const id=items[idx]?.dataset.productId;if(!id)return false;const p=(await window.hesabdari.products.search($('qName').value)).find(x=>x.id===id);if(!p)return false;await selectProduct(p.id,p.name);return true}
async function setupQuick(){
  const name=$('qName'),qty=$('qQty'),price=$('qPrice'),s=$('suggestions');
  selectedProductId=null;suggestionIndex=-1;qPriceManual=false;name.focus();
  name.oninput=async()=>{selectedProductId=null;suggestionIndex=-1;qPriceManual=false;const r=await window.hesabdari.products.search(name.value);s.innerHTML=r.map((x,i)=>`<div class="suggestion-item" data-product-id="${esc(x.id)}"><b>${esc(x.name)}</b><small>${fmt(x.stock)} ${esc(x.unit)} موجودی</small></div>`).join('');s.classList.toggle('hidden',!r.length);s.querySelectorAll('.suggestion-item').forEach((el,i)=>el.addEventListener('mouseenter',()=>highlightSuggestion(i)));s.querySelectorAll('.suggestion-item').forEach(el=>el.addEventListener('click',()=>selectProduct(el.dataset.productId,el.querySelector('b').textContent)));await updatePricePreview()};
  qty.oninput=updatePricePreview;
  price.oninput=()=>{qPriceManual=true};
  name.onkeydown=async e=>{if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();const r=await window.hesabdari.products.search(name.value);if(!r.length)return;s.classList.remove('hidden');highlightSuggestion(suggestionIndex<0?(e.key==='ArrowDown'?0:suggestionItems().length-1):suggestionIndex+(e.key==='ArrowDown'?1:-1));return}if(e.key==='Enter'){e.preventDefault();if(!selectedProductId){const r=await window.hesabdari.products.search(name.value);if(r.length===1){await selectProduct(r[0].id,r[0].name)}else if(r.length>1){s.classList.remove('hidden');if(suggestionIndex<0)highlightSuggestion(0);await chooseSuggestion();return}else{return}}qty.focus();qty.select()}};
  qty.onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();if(!(Number(qty.value)>0))return toast('مقدار را وارد کنید');price.focus();price.select()}};
  price.onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();addQuick()}};
}
async function selectProduct(id,name){selectedProductId=id;$('qName').value=name;$('suggestions').classList.add('hidden');suggestionIndex=-1;qPriceManual=false;const p=products.find(x=>x.id===id)||(await window.hesabdari.products.search(name)).find(x=>x.id===id);if(p){$('qUnit').value=p.unit||'گرم';$('qQty').step=p.unit==='عدد'?'1':'0.1';$('qQty').min=p.unit==='عدد'?'1':'0.1'}await updatePricePreview();$('qQty').focus();$('qQty').select()}
async function updatePricePreview(){const q=Number($('qQty')?.value||0),name=$('qName')?.value||'';if(!selectedProductId&&name){const r=await window.hesabdari.products.search(name);if(r.length===1)selectedProductId=r[0].id}if(!selectedProductId||!(q>0)){if($('qPrice')&&!qPriceManual)$('qPrice').value='';if($('tierHint'))$('tierHint').textContent='ابتدا کالا و مقدار را وارد کنید.';return}const p=products.find(x=>x.id===selectedProductId)||(await window.hesabdari.products.search(name))[0];if($('qUnit'))$('qUnit').value=p.unit||'گرم';const tiers=await window.hesabdari.products.tiers(selectedProductId);const existing=Number((currentInvoice?.items||[]).filter(x=>x.product_id===selectedProductId).reduce((a,x)=>a+Number(x.quantity||0),0));const total=existing+q;const t=tiers.find(x=>{const min=Number(x.min_qty);const max=x.max_qty===null||x.max_qty===undefined||Number(x.max_qty)===0?null:Number(x.max_qty);return total>=min&&(max===null||total<=max)});const price=t?Number(t.price_per_unit):Number(p.sale_price_per_unit);if($('qPrice')&&!qPriceManual)$('qPrice').value=Math.round(price);$('tierHint').innerHTML=t?`سطح قیمت <b>${t.tier_order}</b> · مقدار کل ${fmt(total)} ${esc(p.unit||'واحد')} · بازه ${fmt(t.min_qty)} تا ${t.max_qty===null||t.max_qty===undefined||Number(t.max_qty)===0?'∞':fmt(t.max_qty)} ${esc(p.unit||'واحد')} · مبلغ تقریبی <b>${fmt(total*price)} تومان</b>`:`قیمت پایه · مقدار کل ${fmt(total)} ${esc(p.unit||'واحد')}.`}
async function addQuick(){if(!selectedProductId){const r=await window.hesabdari.products.search($('qName').value);if(r.length===1)selectedProductId=r[0].id;else return toast('ابتدا یک کالا را از پیشنهادها انتخاب کنید')}const qty=Number($('qQty').value);const unitPrice=Number($('qPrice').value||0);if(!(qty>0))return toast('مقدار را وارد کنید');if(!(unitPrice>=0))return toast('قیمت فروش نامعتبر است');try{currentInvoice=await window.hesabdari.invoices.addItem({invoiceId:currentInvoice.id,productId:selectedProductId,quantity:qty,unitPrice,manualPrice:qPriceManual});selectedProductId=null;qPriceManual=false;toast('کالا به فاکتور اضافه شد');renderSale()}catch(e){toast(e.message)}}
async function removeItem(id){currentInvoice=await window.hesabdari.invoices.removeItem({invoiceId:currentInvoice.id,itemId:id});renderSale()}
async function setDiscount(v){const pct=Math.max(0,Math.min(100,Number(v)||0));try{currentInvoice=await window.hesabdari.invoices.discount({invoiceId:currentInvoice.id,discountPercent:pct});await renderSale();$('customerSelect')?.focus()}catch(e){toast(e.message)}}
async function loadCustomersForInvoice(){const sel=$('customerSelect');if(!sel)return;const list=await window.hesabdari.customers.list();sel.innerHTML='<option value="">مشتری متفرقه</option>'+list.map(x=>`<option value="${esc(x.id)}" ${x.id===currentInvoice.customer_id?'selected':''}>${esc(x.name)}${x.phone?' — '+esc(x.phone):''}</option>`).join('')}
async function setCustomer(id){try{currentInvoice=await window.hesabdari.invoices.setCustomer({invoiceId:currentInvoice.id,customerId:id||null});toast('مشتری فاکتور به‌روزرسانی شد')}catch(e){toast(e.message)}}
function selectPayment(method, focusFinal=false){if(!currentInvoice?.items?.length)return toast('فاکتور خالی است');selectedPaymentMethod=method;['CASH','CARD','ACCOUNT'].forEach(m=>$('pay'+(m==='CASH'?'Cash':m==='CARD'?'Card':'Account')+'Btn')?.classList.toggle('selected',m===method));$('paymentHint').textContent=method==='CASH'?`کل مبلغ ${fmt(currentInvoice.total)} تومان به‌صورت نقدی ثبت می‌شود.`:method==='CARD'?`کل مبلغ ${fmt(currentInvoice.total)} تومان به‌صورت کارت / اعتباری ثبت می‌شود.`:`کل مبلغ ${fmt(currentInvoice.total)} تومان به‌صورت نسیه در حساب مشتری ثبت می‌شود.`;$('finalNoPrint').disabled=false;$('finalPrint').disabled=false;if(focusFinal)$('finalNoPrint')?.focus()}
function setupSaleKeyboard(){
  const customer=$('customerSelect'), methods=[$('payCashBtn'),$('payCardBtn'),$('payAccountBtn')].filter(Boolean), noPrint=$('finalNoPrint'), print=$('finalPrint');
  customer?.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();methods[0]?.focus()}});
  methods.forEach((btn,index)=>btn.addEventListener('keydown',e=>{
    if(e.key==='Enter'){e.preventDefault();selectPayment(['CASH','CARD','ACCOUNT'][index],true);return}
    if(['ArrowRight','ArrowDown'].includes(e.key)){e.preventDefault();methods[(index+1)%methods.length]?.focus()}
    if(['ArrowLeft','ArrowUp'].includes(e.key)){e.preventDefault();methods[(index-1+methods.length)%methods.length]?.focus()}
  }));
  noPrint?.addEventListener('keydown',e=>{if(e.key==='ArrowDown'||e.key==='ArrowRight'){e.preventDefault();print?.focus()}else if(e.key==='Enter'){e.preventDefault();confirmPayment(false)}});
  print?.addEventListener('keydown',e=>{if(e.key==='ArrowLeft'||e.key==='ArrowUp'){e.preventDefault();noPrint?.focus()}else if(e.key==='Enter'){e.preventDefault();confirmPayment(true)}});
}
async function openPayment(){if(!currentInvoice?.items?.length)return toast('فاکتور خالی است');document.querySelector('#paymentHint')?.scrollIntoView({block:'nearest'});selectPayment(selectedPaymentMethod||'CASH',true)}
async function confirmPayment(printReceipt=false){if(!selectedPaymentMethod)return toast('ابتدا روش پرداخت را انتخاب کنید');try{const paid=await window.hesabdari.invoices.pay({invoiceId:currentInvoice.id,payments:[{method:selectedPaymentMethod,amount:Math.round(Number(currentInvoice.total)||0)}]});toast('فروش با موفقیت ثبت شد');if(printReceipt){try{await window.hesabdari.receipt.print(paid.id)}catch(e){toast('فروش ثبت شد؛ چاپ رسید انجام نشد')}}currentInvoice=null;go('sales')}catch(e){toast(e.message)}}
async function pay(method){selectPayment(method||'CASH')}
async function loadProducts(){products=await window.hesabdari.products.list()}
async function openBulkReprice(){
  $('modalTitle').textContent='تغییر گروهی قیمت فروش';
  $('modalBody').innerHTML=`<div class="tier-hint">این عملیات فقط قیمت فروش پایه و تمام پله‌های قیمت فروش کالاهای فعال را تغییر می‌دهد. قیمت خرید، موجودی، فروش‌های ثبت‌شده و فاکتورهای قبلی تغییر نمی‌کنند.</div><div class="formgrid"><label>نوع تغییر<select id="bulkPriceDirection"><option value="increase">افزایش قیمت</option><option value="decrease">کاهش قیمت</option></select></label><label>درصد تغییر<input id="bulkPricePercent" type="number" min="0.01" max="1000" step="0.01" value="15"></label><label>توضیح (اختیاری)<input id="bulkPriceNote" placeholder="مثلاً افزایش قیمت مواد اولیه"></label></div><div id="bulkPricePreview" class="tier-hint"></div><div class="payrow"><button onclick="previewBulkReprice()">پیش‌نمایش</button><button class="primary" onclick="applyBulkReprice()">اعمال تغییر قیمت</button></div>`;
  $('modal').classList.remove('hidden'); previewBulkReprice(); $('bulkPricePercent')?.focus();
}
function previewBulkReprice(){
  const pct=Number($('bulkPricePercent')?.value||0), dir=$('bulkPriceDirection')?.value==='decrease'?-1:1, active=products.filter(p=>Number(p.active??1)!==0), sign=dir>0?'+':'−';
  const sample=active.slice(0,3).map(p=>{const old=Number(p.sale_price_per_unit||0);return `${esc(p.name)}: ${fmt(old)} → ${fmt(Math.round(old*(1+dir*pct/100)))}`}).join('<br>');
  if($('bulkPricePreview'))$('bulkPricePreview').innerHTML=`<b>${fmt(active.length)} کالا</b> تحت تأثیر قرار می‌گیرند · تغییر ${sign}${fmt(pct)}٪ · تمام پله‌های قیمت فروش نیز به همین درصد تغییر می‌کنند.${sample?`<hr>${sample}`:''}`;
}
async function applyBulkReprice(){
  const pct=Number($('bulkPricePercent').value||0), direction=$('bulkPriceDirection').value, note=$('bulkPriceNote').value.trim(); if(!(pct>0))return toast('درصد تغییر قیمت را وارد کنید');
  const count=products.filter(p=>Number(p.active??1)!==0).length, text=direction==='increase'?`افزایش ${fmt(pct)}٪`:`کاهش ${fmt(pct)}٪`;
  if(!confirm(`آیا ${text} روی قیمت فروش پایه و همه پله‌های ${fmt(count)} کالای فعال اعمال شود؟\n\nقیمت خرید، موجودی و فاکتورهای قبلی تغییر نمی‌کنند.`))return;
  try{const r=await window.hesabdari.products.bulkReprice({percentage:pct,direction,note});closeModal();await loadProducts();renderProducts();await loadPriceHistory();toast(`${text} با موفقیت روی ${fmt(r.affectedProducts)} کالا اعمال شد`)}catch(e){toast(e.message)}
}
async function loadPriceHistory(){
  const el=$('priceHistoryTable'); if(!el)return; try{const list=await window.hesabdari.products.priceHistory({limit:80});
    el.innerHTML=list.length?`<table><thead><tr><th>زمان</th><th>کالا</th><th>نوع</th><th>پله</th><th>قدیم</th><th>جدید</th><th>درصد</th><th>توضیح</th></tr></thead><tbody>${list.map(x=>`<tr><td>${new Date(x.created_at).toLocaleString('fa-IR')}</td><td><b>${esc(x.product_name)}</b></td><td>${x.price_type==='BASE'?'پایه':'پله‌ای'}</td><td>${x.tier_order?fmt(x.tier_order):'—'}</td><td>${fmt(x.old_price)}</td><td><b>${fmt(x.new_price)}</b></td><td class="${Number(x.percentage)>=0?'positive':'low'}">${Number(x.percentage)>=0?'+':'−'}${fmt(Math.abs(x.percentage))}٪</td><td>${esc(x.note||'—')}</td></tr>`).join('')}</tbody></table>`:'<p class="empty">تغییر قیمت گروهی ثبت نشده است.</p>';
  }catch(e){el.innerHTML=`<p class="empty">${esc(e.message)}</p>`}
}
function renderProducts(){const q=($('productSearch')?.value||'').trim();const list=products.filter(x=>x.name.includes(q));$('productsTable').innerHTML=`<table><thead><tr><th>نام کالا</th><th>دسته</th><th>خرید</th><th>فروش پایه/واحد</th><th>موجودی</th><th>حداقل</th><th></th></tr></thead><tbody>${list.map(x=>`<tr><td><b>${esc(x.name)}</b></td><td>${esc(x.category_name||'-')}</td><td>${fmt(x.purchase_price)}</td><td>${fmt(x.sale_price_per_unit)}</td><td class="${x.stock<=x.min_stock?'low':''}">${fmt(x.stock)} ${esc(x.unit)}</td><td>${fmt(x.min_stock)}</td><td><button class="ghost" onclick="openProductForm('${x.id}')">ویرایش</button> <button class="danger" onclick="archiveProduct('${x.id}')">آرشیو</button></td></tr>`).join('')||'<tr><td colspan="7" class="empty-cell">کالایی پیدا نشد.</td></tr>'}</tbody></table>`}
async function openProductForm(id){
  let p=id?products.find(x=>x.id===id):null;
  let tiers=id?await window.hesabdari.products.tiers(id):[{min_qty:1,max_qty:150,price_per_unit:p?.sale_price_per_unit||0},{min_qty:151,max_qty:350,price_per_unit:0},{min_qty:351,max_qty:600,price_per_unit:0},{min_qty:601,max_qty:950,price_per_unit:0},{min_qty:951,max_qty:null,price_per_unit:0}];
  const cats=await window.hesabdari.categories.list();
  const catOptions=cats.map(c=>`<option value="${esc(c.id)}" ${p?.category_id===c.id?'selected':''}>${esc(c.name)}</option>`).join('');
  $('modalTitle').textContent=p?'ویرایش کالا':'کالای جدید';
  $('modalBody').innerHTML=`<div class="formgrid"><label>نام کالا<input id="fName" value="${esc(p?.name||'')}"></label><label>دسته‌بندی<select id="fCat">${catOptions}</select></label><label>قیمت خرید<input id="fBuy" type="number" min="0" value="${p?.purchase_price||0}"></label><label>واحد کالا<select id="fUnit"><option value="گرم" ${p?.unit==='گرم'||!p?'selected':''}>گرم</option><option value="عدد" ${p?.unit==='عدد'?'selected':''}>عدد</option></select></label><label>قیمت فروش پایه هر واحد (تومان)<input id="fSale" type="number" min="0" value="${p?.sale_price_per_unit||0}"></label>${p?`<label>موجودی فعلی<input value="${p.stock} ${esc(p.unit)}" readonly></label>`:`<label>موجودی اولیه<input id="fInitial" type="number" min="0" step="0.1" value="0"></label>`}<label>حداقل موجودی<input id="fMin" type="number" min="0" step="0.1" value="${p?.min_stock||0}"></label></div><div class="payrow"><button onclick="manageCategories()">مدیریت دسته‌بندی‌ها</button></div><h3 class="modal-subtitle">قیمت‌گذاری پله‌ای</h3><p class="tier-hint">پله آخر را با «تا = ∞» تعریف کنید. تعداد پله‌ها محدود به پنج مورد نیست.</p><div id="tierGrid" class="tier-grid"></div><button onclick="addTierRow()">+ افزودن پله</button><button class="primary" onclick="saveProduct('${esc(id||'')}')">ذخیره کالا</button>`;
  window.currentTierRows = tiers.map(t=>({min_qty:t.min_qty,max_qty:t.max_qty,price_per_unit:t.price_per_unit}));
  renderTierRows();
  $('modal').classList.remove('hidden');
}
function renderTierRows(){
  const grid=$('tierGrid'); if(!grid)return;
  grid.innerHTML=(window.currentTierRows||[]).map((t,i)=>`<div class="tier-row" data-tier-index="${i}"><b>پله ${i+1}</b><label>از<input class="tmin" type="number" min="0.1" step="0.1" value="${t.min_qty}"></label><label>تا<input class="tmax" type="number" min="0.1" step="0.1" placeholder="∞" value="${t.max_qty??''}"></label><label>قیمت واحد<input class="tprice" type="number" min="0" value="${t.price_per_unit}"></label><button type="button" onclick="removeTierRow(${i})">حذف</button></div>`).join('');
}
function addTierRow(){
  const rows=window.currentTierRows||[]; const last=rows[rows.length-1]||{min_qty:1,max_qty:null,price_per_unit:Number($('fSale')?.value)||0};
  if(last.max_qty===null||last.max_qty===''){toast('ابتدا برای پله آخر حد بالا تعیین کنید');return;}
  const nextMin=Number(last.max_qty)+0.1; rows.push({min_qty:nextMin,max_qty:null,price_per_unit:Number(last.price_per_unit)||0}); renderTierRows();
}
function removeTierRow(index){
  const rows=window.currentTierRows||[]; if(rows.length<=1){toast('حداقل یک پله لازم است');return;} rows.splice(index,1); renderTierRows();
}
async function saveProduct(id){
  const sale=Number($('fSale').value)||0;
  const tiers=[...document.querySelectorAll('#tierGrid .tier-row')].map(row=>({min_qty:Number(row.querySelector('.tmin').value),max_qty:row.querySelector('.tmax').value.trim()===''?null:Number(row.querySelector('.tmax').value),price_per_unit:Number(row.querySelector('.tprice').value)||0}));
  if(!tiers.length){toast('حداقل یک پله قیمت لازم است');return;}
  if(!tiers[0].price_per_unit)tiers[0].price_per_unit=sale;
  try{await window.hesabdari.products.save({id:id||null,name:$('fName').value.trim(),purchase_price:Number($('fBuy').value)||0,sale_price_per_unit:sale,unit:$('fUnit').value,initial_stock:id?undefined:Number($('fInitial').value)||0,min_stock:Number($('fMin').value)||0,category_id:$('fCat').value||null,category_name:$('fCat').selectedOptions[0]?.textContent?.trim()||'',tiers});closeModal();await loadProducts();renderProducts();toast('کالا ذخیره شد')}catch(e){toast(e.message)}}
async function manageCategories(){const cats=await window.hesabdari.categories.list();$('modalTitle').textContent='مدیریت دسته‌بندی‌ها';$('modalBody').innerHTML=`<div class="formgrid"><label>دسته جدید<input id="newCatName" placeholder="مثلاً ادویه‌ها"></label><button class="primary" onclick="saveCategory()">افزودن</button></div><div class="table-wrap"><table><thead><tr><th>دسته</th><th>تعداد کالا</th><th></th></tr></thead><tbody>${cats.map(c=>`<tr><td>${esc(c.name)}</td><td>${fmt(c.product_count)}</td><td><button onclick="renameCategory('${esc(c.id)}')">ویرایش</button> <button class="danger" onclick="archiveCategory('${esc(c.id)}')">حذف</button></td></tr>`).join('')}</tbody></table></div><button onclick="openProductForm()">بازگشت به کالا</button>`;$('modal').classList.remove('hidden')}
async function saveCategory(){try{await window.hesabdari.categories.save({name:$('newCatName').value});toast('دسته‌بندی اضافه شد');await manageCategories()}catch(e){toast(e.message)}}
async function renameCategory(id){const cats=await window.hesabdari.categories.list();const current=cats.find(x=>x.id===id);if(!current)return;const n=prompt('نام جدید دسته‌بندی',current.name);if(n===null)return;try{await window.hesabdari.categories.save({id,name:n});toast('دسته‌بندی ویرایش شد');await manageCategories()}catch(e){toast(e.message)}}
async function archiveCategory(id){if(!confirm('دسته‌بندی حذف شود؟'))return;try{await window.hesabdari.categories.archive(id);toast('دسته‌بندی حذف شد');await manageCategories()}catch(e){toast(e.message)}}
async function archiveProduct(id){if(!confirm('کالا آرشیو شود؟ در فروش‌های قبلی باقی می‌ماند ولی برای فروش جدید نمایش داده نمی‌شود.'))return;try{await window.hesabdari.products.archive(id);await loadProducts();renderProducts();toast('کالا آرشیو شد')}catch(e){toast(e.message)}}

async function loadCustomers(){
  const list=await window.hesabdari.customers.list(); window._customerCache=list;
  $('customersTable').innerHTML=list.length?`<table><thead><tr><th>نام</th><th>تلفن</th><th>مانده</th><th>وضعیت</th><th></th></tr></thead><tbody>${list.map(x=>{const b=Number(x.balance||0);return `<tr><td><b>${esc(x.name)}</b></td><td>${esc(x.phone||'-')}</td><td>${fmt(Math.abs(b))} تومان</td><td>${b>0?'بدهکار':b<0?'بستانکار':'تسویه'}</td><td><button onclick="showCustomerAccount('${esc(x.id)}')">گردش حساب</button> <button onclick="openCustomerPayment('${esc(x.id)}')">دریافت</button> ${Number(x.balance)>0?`<button onclick="settleCustomer('${esc(x.id)}')">تسویه کامل</button>`:''}</td></tr>`}).join('')}</tbody></table>`:'<p class="empty">هنوز مشتری ثبت نشده است.</p>';
  if(list[0] && !$('customerAccountTitle').dataset.id) await showCustomerAccount(list[0].id);
}
async function showCustomerAccount(id){
  const sum=await window.hesabdari.customers.summary(id); const list=await window.hesabdari.customers.ledger(id); const c=sum.customer;
  $('customerAccountTitle').textContent=`حساب ${c.name}`; $('customerAccountTitle').dataset.id=id; $('customerAccountHint').textContent=c.phone?`تلفن: ${c.phone}`:'بدون شماره تلفن';
  const b=Number(sum.balance||0); $('customerSummary').innerHTML=`<div class="stat"><span>بدهکار</span><strong>${fmt(sum.debit)}</strong><em>تومان</em></div><div class="stat"><span>بستانکار</span><strong>${fmt(sum.credit)}</strong><em>تومان</em></div><div class="stat"><span>مانده</span><strong>${fmt(Math.abs(b))}</strong><em>${b>0?'بدهکار':b<0?'بستانکار':'تسویه'}</em></div>`;
  $('customerLedger').innerHTML=list.length?`<table><thead><tr><th>تاریخ</th><th>شرح</th><th>بدهکار</th><th>بستانکار</th><th>مانده</th></tr></thead><tbody>${list.map(x=>`<tr><td>${new Date(x.created_at).toLocaleString('fa-IR')}</td><td>${esc(x.note||x.entry_type)}</td><td>${x.direction==='DEBIT'?fmt(x.amount):'-'}</td><td>${x.direction==='CREDIT'?fmt(x.amount):'-'}</td><td>${fmt(Math.abs(x.balance_after))} ${x.balance_after>0?'بدهکار':x.balance_after<0?'بستانکار':'تسویه'}</td></tr>`).join('')}</tbody></table>`:'<p class="empty">گردشی برای این مشتری ثبت نشده است.</p>';
}
function openCustomerForm(){
  $('modalTitle').textContent='مشتری جدید'; $('modalBody').innerHTML=`<div class="formgrid"><label>نام مشتری<input id="cName"></label><label>تلفن<input id="cPhone"></label></div><button class="primary" onclick="saveCustomer()">ذخیره مشتری</button>`; $('modal').classList.remove('hidden'); $('cName').focus();
}
async function saveCustomer(){try{const c=await window.hesabdari.customers.save({name:$('cName').value,phone:$('cPhone').value});closeModal();await loadCustomers();await showCustomerAccount(c.id);toast('مشتری ثبت شد')}catch(e){toast(e.message)}}
function openCustomerPayment(id){
  const row=window._customerCache?.find(x=>x.id===id); const balance=Number(row?.balance||0);
  $('modalTitle').textContent='دریافت از مشتری'; $('modalBody').innerHTML=`<div class="formgrid"><label>مبلغ<input id="cpAmount" type="number" min="1" step="1000" value="${balance>0?balance:''}"></label><label>روش دریافت<select id="cpMethod"><option value="CASH">نقدی</option><option value="CARD">کارت</option></select></label><label>توضیح<input id="cpNote" placeholder="مثلاً تسویه بخشی از حساب"></label></div><button class="primary" onclick="saveCustomerPayment('${esc(id)}')">ثبت دریافت</button>`; $('modal').classList.remove('hidden');
}
async function saveCustomerPayment(id){try{const r=await window.hesabdari.customers.payment({customerId:id,amount:Number($('cpAmount').value),method:$('cpMethod').value,note:$('cpNote').value});closeModal();await loadCustomers();await showCustomerAccount(id);toast(`دریافت ${fmt(r.amount)} تومان ثبت شد`)}catch(e){toast(e.message)}}
async function settleCustomer(id){const method=String(prompt('روش تسویه کامل: CASH / CARD','CASH')||'').toUpperCase();if(!['CASH','CARD'].includes(method))return toast('روش تسویه نامعتبر است');try{const r=await window.hesabdari.customers.settle({customerId:id,method,note:'تسویه کامل'});await loadCustomers();await showCustomerAccount(id);toast(`تسویه ${fmt(r.amount)} تومان انجام شد`)}catch(e){toast(e.message)}}

function closeModal(){$('modal').classList.add('hidden')}
async function loadInventory(){products=await window.hesabdari.products.list();const sel=$('stockProduct');sel.innerHTML=products.map(x=>`<option value="${x.id}">${esc(x.name)} — ${fmt(x.stock)} ${esc(x.unit)}</option>`).join('')||'<option value="">کالایی وجود ندارد</option>';await loadStockMovements()}
async function loadStockMovements(){const id=$('stockProduct')?.value;if(!id)return;$('stockCurrent').textContent='در حال بارگذاری...';const p=products.find(x=>x.id===id);if(p)$('stockCurrent').innerHTML=`موجودی فعلی: <b>${fmt(p.stock)} ${esc(p.unit)}</b> · حداقل: ${fmt(p.min_stock)} ${esc(p.unit)}`;const list=await window.hesabdari.stock.movements(id);$('stockMovements').innerHTML=list.map(x=>`<tr><td>${new Date(x.created_at).toLocaleString('fa-IR')}</td><td>${esc(x.movement_type)}</td><td>${fmt(x.quantity)} ${esc(x.unit)}</td><td>${esc(x.note||'-')}</td></tr>`).length?`<table><thead><tr><th>زمان</th><th>نوع</th><th>مقدار</th><th>توضیح</th></tr></thead><tbody>${list.map(x=>`<tr><td>${new Date(x.created_at).toLocaleString('fa-IR')}</td><td>${esc(x.movement_type)}</td><td class="${Number(x.quantity)<0?'low':''}">${fmt(x.quantity)} ${esc(x.unit)}</td><td>${esc(x.note||'-')}</td></tr>`).join('')}</tbody></table>`:'<p class="empty">گردشی ثبت نشده است.</p>'}
async function adjustStock(){const productId=$('stockProduct').value;const quantity=Number($('stockQty').value);const movementType=$('stockType').value;const note=$('stockNote').value.trim();try{await window.hesabdari.stock.adjust({productId,quantity,movementType,note});$('stockQty').value='';$('stockNote').value='';await loadInventory();toast('گردش انبار ثبت شد')}catch(e){toast(e.message)}}
async function returnInvoice(id){
  try{
    const inv=await window.hesabdari.invoices.get(id); if(!inv||!['PAID','PARTIALLY_RETURNED'].includes(inv.status)) return toast('این فاکتور قابل برگشت نیست');
    const previous=await window.hesabdari.invoices.returns(id); const returned={}; previous.forEach(r=>returned[r.invoice_item_id]=(returned[r.invoice_item_id]||0)+Number(r.quantity||0));
    const rows=inv.items.map((x,n)=>`${n+1}) ${x.product_name} — فروخته: ${fmt(x.quantity)} ${x.unit} — قابل برگشت: ${fmt(Math.max(0,Number(x.quantity)-(returned[x.id]||0)))} ${x.unit}`).join('\n');
    const choice=prompt(`شماره قلم را وارد کنید:\n${rows}`); if(choice===null)return; const index=Number(choice)-1; if(!Number.isInteger(index)||!inv.items[index])return toast('شماره قلم نامعتبر است');
    const item=inv.items[index]; const max=Math.max(0,Number(item.quantity)-(returned[item.id]||0)); if(max<=0)return toast('این قلم قبلاً کامل برگشت خورده است');
    const q=Number(prompt(`مقدار برگشتی ${item.product_name} (حداکثر ${max} ${item.unit}):`,String(max))); if(!(q>0)||q>max)return toast('مقدار برگشتی نامعتبر است');
    const method=String(prompt('روش برگشت وجه: CASH / CARD / ACCOUNT','CASH')||'').toUpperCase(); if(!['CASH','CARD','ACCOUNT'].includes(method))return toast('روش برگشت نامعتبر است');
    const result=await window.hesabdari.invoices.return({invoiceId:id,items:[{itemId:item.id,quantity:q}],method,note:'برگشت از فروش'});
    toast(`مرجوعی ${fmt(result.returnNo)} ثبت شد؛ مبلغ برگشت ${fmt(result.refundTotal)} تومان`); loadReports();
  }catch(e){toast(e.message)}
}

async function cancelCurrentInvoice(){if(!currentInvoice)return;if(!confirm('فاکتور باز لغو شود؟'))return;try{await window.hesabdari.invoices.cancel(currentInvoice.id);toast('فاکتور لغو شد');currentInvoice=null;go('sales')}catch(e){toast(e.message)}}

async function loadCash(){const r=await window.hesabdari.cash.status();$('cashStatus').textContent=r.open?'باز':'بسته';$('cashExpected').textContent=fmt(r.expected);$('cashInfo').innerHTML=r.open?`صندوق باز است. موجودی مورد انتظار: <b>${fmt(r.expected)} تومان</b>`:'صندوق بسته است. برای فروش نقدی، ابتدا صندوق را باز کنید';if(r.open){const h=await window.hesabdari.cash.movements(r.register.id);$('cashHistory').innerHTML=`<table><thead><tr><th>تاریخ</th><th>نوع</th><th>جهت</th><th>مبلغ</th><th>توضیح</th></tr></thead><tbody>${h.map(x=>`<tr><td>${esc(x.created_at||'')}</td><td>${esc(x.category||x.movement_type)}</td><td>${x.direction==='IN'?'ورود':'خروج'}</td><td>${fmt(x.amount)} تومان</td><td>${esc(x.note||'')}</td></tr>`).join('')}</tbody></table>`||'<p class="empty">گردشی ثبت نشده است.</p>';}else $('cashHistory').innerHTML='<p class="empty">صندوق بسته است.</p>'}
async function openCash(){try{await window.hesabdari.cash.open({openingCash:Number($('cashAmount').value||0),note:$('cashNote').value});$('cashAmount').value='';$('cashNote').value='';await loadCash();toast('صندوق باز شد')}catch(e){toast(e.message)}}
async function cashMove(type){try{await window.hesabdari.cash.move({movementType:type,amount:Number($('cashAmount').value),note:$('cashNote').value.trim(),category:type==='OUT'?($('cashCategory').value||'GENERAL'):'GENERAL'});$('cashAmount').value='';$('cashNote').value='';await loadCash();toast(type==='IN'?'ورود وجه ثبت شد':'خروج وجه ثبت شد')}catch(e){toast(e.message)}}
async function closeCash(){try{const actual=Number($('cashAmount').value);const r=await window.hesabdari.cash.close({closingCash:actual,note:$('cashNote').value});$('cashAmount').value='';$('cashNote').value='';$('cashCloseResult').innerHTML=`تسویه شیفت انجام شد. انتظار قبل از شمارش: <b>${fmt(r.expected)}</b> تومان · شمارش واقعی: <b>${fmt(r.actual)}</b> · مغایرت: <b>${fmt(r.discrepancy)}</b> تومان`;await loadCash();toast(`صندوق بسته شد · مغایرت ${fmt(r.discrepancy)} تومان`)}catch(e){toast(e.message)}}

async function loadPurchasePage(){try{products=await window.hesabdari.products.list();suppliers=await window.hesabdari.suppliers.list();$('suppliersTable').innerHTML=suppliers.length?`<table><thead><tr><th>تأمین‌کننده</th><th>تلفن</th><th>مانده بدهی</th><th></th></tr></thead><tbody>${suppliers.map(x=>`<tr><td>${esc(x.name)}</td><td>${esc(x.phone||'-')}</td><td>${fmt(x.balance)} تومان</td><td><button onclick="paySupplier('${x.id}')">پرداخت بدهی</button></td></tr>`).join('')}</tbody></table>`:'<p class="empty">تأمین‌کننده‌ای ثبت نشده است.</p>';const opens=await window.hesabdari.purchase.listOpen();$('purchaseList').innerHTML=opens.length?`<table><thead><tr><th>شماره</th><th>تأمین‌کننده</th><th>جمع</th><th>وضعیت</th><th></th></tr></thead><tbody>${opens.map(x=>`<tr><td>${fmt(x.purchase_no)}</td><td>${esc(x.supplier_name)}</td><td>${fmt(x.total)} تومان</td><td>${esc(x.status)}</td><td><button class="primary" onclick="editPurchase('${x.id}')">ادامه</button></td></tr>`).join('')}</tbody></table>`:'<p class="empty">فاکتور خرید بازی وجود ندارد.</p>';}catch(e){toast(e.message)}}
function newSupplier(){$('modalTitle').textContent='تأمین‌کننده جدید';$('modalBody').innerHTML=`<div class="formgrid"><label>نام<input id="supName"></label><label>تلفن<input id="supPhone"></label><label>آدرس<input id="supAddress"></label></div><button class="primary" onclick="saveSupplier()">ذخیره تأمین‌کننده</button>`;$('modal').classList.remove('hidden');$('supName').focus()}
async function saveSupplier(){try{await window.hesabdari.suppliers.save({name:$('supName').value,phone:$('supPhone').value,address:$('supAddress').value});closeModal();await loadPurchasePage();toast('تأمین‌کننده ثبت شد')}catch(e){toast(e.message)}}
async function newPurchase(){try{if(!suppliers.length){toast('ابتدا یک تأمین‌کننده ثبت کنید');return}openModal('انتخاب تأمین‌کننده',`<label>تأمین‌کننده<select id="newPurchaseSupplier">${suppliers.map(x=>`<option value="${esc(x.id)}">${esc(x.name)}</option>`).join('')}</select></label><button class="primary" onclick="createPurchase()">ایجاد فاکتور خرید</button>`)}catch(e){toast(e.message)}}
async function createPurchase(){try{currentPurchase=await window.hesabdari.purchase.new({supplierId:$('newPurchaseSupplier').value});closeModal();renderPurchaseEditor();await loadPurchasePage();toast(`فاکتور خرید ${fmt(currentPurchase.invoice.purchase_no)} ایجاد شد`)}catch(e){toast(e.message)}}
async function editPurchase(id){try{currentPurchase=await window.hesabdari.purchase.get(id);renderPurchaseEditor()}catch(e){toast(e.message)}}
function renderPurchaseEditor(){const inv=currentPurchase.invoice, items=currentPurchase.items;const productOptions=products.map(p=>`<option value="${esc(p.id)}">${esc(p.name)} — ${esc(p.unit)}</option>`).join('');$('purchaseEditor').classList.remove('hidden');$('purchaseEditor').innerHTML=`<div class="card-title"><div><h2>فاکتور خرید شماره ${fmt(inv.purchase_no)}</h2><p>تأمین‌کننده: <b>${esc(inv.supplier_name)}</b> · جمع: <b>${fmt(inv.total)} تومان</b> · بدهی: <b>${fmt(inv.due_amount)} تومان</b></p></div><button onclick="$('purchaseEditor').classList.add('hidden')">بستن</button></div><div class="formgrid"><label>کالا<select id="purchaseProduct">${productOptions}</select></label><label>مقدار<input id="purchaseQty" type="number" min="0.001" step="0.001" value="1"></label><label>قیمت خرید واحد<input id="purchasePrice" type="number" min="0" step="1" value="0"></label></div><button class="primary" onclick="addPurchaseItem()">افزودن قلم</button><div class="table-wrap" style="margin-top:16px">${items.length?`<table><thead><tr><th>کالا</th><th>تعداد</th><th>قیمت خرید</th><th>تخفیف</th><th>مبلغ</th><th></th></tr></thead><tbody>${items.map(x=>`<tr><td>${esc(x.product_name)}</td><td>${fmt(x.quantity)} ${esc(x.unit)}</td><td>${fmt(x.purchase_unit_price)}</td><td>${fmt(x.discount)}</td><td>${fmt(x.amount)} تومان</td><td><button class="danger" onclick="removePurchaseItem('${x.id}')">حذف</button></td></tr>`).join('')}</tbody></table>`:'<p class="empty">هنوز قلمی اضافه نشده است.</p>'}</div><div class="formgrid"><label>تخفیف کل<input id="purchaseDiscount" type="number" min="0" step="1" value="${Number(inv.discount||0)}"></label></div><button onclick="setPurchaseDiscount()">اعمال تخفیف</button><div class="tier-hint">پس از ثبت نهایی، کالا وارد انبار می‌شود و بهای تمام‌شده آن از قیمت واقعی همین فاکتور محاسبه می‌شود.</div><div class="payrow"><button class="primary" onclick="completePurchase(false)">ثبت خرید نسیه / تسویه بعدی</button><button onclick="completePurchase(true)">ثبت و پرداخت کامل</button></div>`}
async function addPurchaseItem(){try{const r=await window.hesabdari.purchase.addItem({purchaseInvoiceId:currentPurchase.invoice.id,productId:$('purchaseProduct').value,quantity:Number($('purchaseQty').value),purchaseUnitPrice:Number($('purchasePrice').value)});currentPurchase=r;renderPurchaseEditor()}catch(e){toast(e.message)}}
async function removePurchaseItem(id){try{currentPurchase=await window.hesabdari.purchase.removeItem({purchaseInvoiceId:currentPurchase.invoice.id,itemId:id});renderPurchaseEditor()}catch(e){toast(e.message)}}
async function setPurchaseDiscount(){try{currentPurchase=await window.hesabdari.purchase.discount({purchaseInvoiceId:currentPurchase.invoice.id,discount:Number($('purchaseDiscount').value||0)});renderPurchaseEditor();toast('تخفیف خرید اعمال شد')}catch(e){toast(e.message)}}
async function completePurchase(full){try{if(!currentPurchase.items.length){toast('فاکتور خرید خالی است');return}let payments=[];if(full){payments=[{method:'CASH',amount:Number(currentPurchase.invoice.total)}]}currentPurchase=await window.hesabdari.purchase.pay({purchaseInvoiceId:currentPurchase.invoice.id,payments});renderPurchaseEditor();await loadPurchasePage();toast(full?'خرید ثبت و پرداخت شد':'خرید ثبت شد و بدهی تأمین‌کننده ایجاد شد')}catch(e){toast(e.message)}}
async function paySupplier(id){const s=suppliers.find(x=>x.id===id);if(!s)return;openModal('پرداخت به تأمین‌کننده',`<p>بدهی فعلی: <b>${fmt(s.balance)} تومان</b></p><div class="formgrid"><label>مبلغ<input id="supplierPayAmount" type="number" min="1" max="${Number(s.balance)}" value="${Number(s.balance)}"></label><label>روش<select id="supplierPayMethod"><option value="CASH">نقدی</option><option value="CARD">کارت / بانک</option></select></label><label>توضیح<input id="supplierPayNote"></label></div><button class="primary" onclick="doSupplierPayment('${id}')">ثبت پرداخت</button>`)}
async function doSupplierPayment(id){try{await window.hesabdari.suppliers.payment({supplierId:id,amount:Number($('supplierPayAmount').value),method:$('supplierPayMethod').value,note:$('supplierPayNote').value});closeModal();await loadPurchasePage();toast('پرداخت تأمین‌کننده ثبت شد')}catch(e){toast(e.message)}}

async function loadAccounting(){try{const e=await window.hesabdari.accounting.entries(500);const t=await window.hesabdari.accounting.trialBalance();const debit=e.reduce((a,x)=>a+Number(x.debit||0),0),credit=e.reduce((a,x)=>a+Number(x.credit||0),0);if($('accEntryCount'))$('accEntryCount').textContent=fmt(e.length);if($('accDebit'))$('accDebit').textContent=fmt(debit);if($('accCredit'))$('accCredit').textContent=fmt(credit);$('accountingEntries').innerHTML=e.length?`<table><thead><tr><th>شماره</th><th>نوع</th><th>شرح</th><th>بدهکار</th><th>بستانکار</th><th>زمان</th></tr></thead><tbody>${e.map(x=>`<tr><td>${fmt(x.entry_no)}</td><td>${esc(x.entry_type)}</td><td>${esc(x.description||'')}</td><td>${fmt(x.debit)} تومان</td><td>${fmt(x.credit)} تومان</td><td>${new Date(x.created_at).toLocaleString('fa-IR')}</td></tr>`).join('')}</tbody></table>`:'<p class="empty">سندی ثبت نشده است.</p>';$('trialBalance').innerHTML=t.length?`<table><thead><tr><th>حساب</th><th>بدهکار</th><th>بستانکار</th><th>مانده</th></tr></thead><tbody>${t.map(x=>`<tr><td>${esc(x.account_name)}</td><td>${fmt(x.debit)}</td><td>${fmt(x.credit)}</td><td>${fmt(x.balance)}</td></tr>`).join('')}</tbody></table>`:'<p class="empty">داده‌ای وجود ندارد.</p>'}catch(e){toast(e.message)}}
async function loadAudit(){try{const a=await window.hesabdari.audit.list({limit:500});$('auditHistory').innerHTML=a.length?`<table><thead><tr><th>زمان</th><th>کاربر</th><th>عملیات</th><th>موجودیت</th><th>مرجع</th><th>جزئیات</th></tr></thead><tbody>${a.map(x=>`<tr><td>${new Date(x.created_at).toLocaleString('fa-IR')}</td><td>${esc(x.actor_name)}</td><td>${esc(x.action)}</td><td>${esc(x.entity_type)}${x.entity_id?' · '+esc(x.entity_id):''}</td><td>${esc(x.reference_type||'-')} ${x.reference_id?'· '+esc(x.reference_id):''}</td><td>${esc(x.details?JSON.stringify(x.details):'-')}</td></tr>`).join('')}</tbody></table>`:'<p class="empty">عملیاتی ثبت نشده است.</p>'}catch(e){toast(e.message)}}

async function loadReports(){const r=await window.hesabdari.reports.summary();$('rTodaySales').textContent=fmt(r.today.sales);$('rTodayInvoices').textContent=fmt(r.today.invoices);$('rProfit').textContent=fmt(r.profit.profit);if($('rCogs'))$('rCogs').textContent=fmt(r.profit.cogs);$('rMonthSales').textContent=fmt(r.month.sales);if($('reportPayments'))$('reportPayments').innerHTML=r.payments.map(x=>`<div class="summary-line"><span>${esc(x.method)}</span><b>${fmt(x.amount)} تومان</b></div>`).join('')||'<p class="empty">پرداختی ثبت نشده است.</p>';if($('reportStockValue'))$('reportStockValue').textContent=fmt(r.stockValue.value)+' تومان';$('reportBest').innerHTML=`<table><thead><tr><th>کالا</th><th>مقدار فروش</th><th>مبلغ فروش</th></tr></thead><tbody>${r.best.map(x=>`<tr><td>${esc(x.product_name)}</td><td>${fmt(x.quantity)} ${esc(x.unit||'واحد')}</td><td>${fmt(x.amount)} تومان</td></tr>`).join('')||'<tr><td colspan="3" class="empty-cell">داده‌ای وجود ندارد.</td></tr>'}</tbody></table>`;const recent=await window.hesabdari.reports.recent();$('recentSales').innerHTML=recent.length?`<table><thead><tr><th>فاکتور</th><th>مبلغ</th><th>روش</th><th>زمان</th><th></th></tr></thead><tbody>${recent.map(x=>`<tr><td>${fmt(x.invoice_no)}</td><td>${fmt(x.total)} تومان</td><td>${esc(x.payment_method||'-')}</td><td>${new Date(x.closed_at).toLocaleString('fa-IR')}</td><td><button class="ghost" onclick="printReceipt('${x.id}')">چاپ رسید</button> <button class="danger" onclick="returnInvoice('${x.id}')">برگشت کالا</button></td></tr>`).join('')}</tbody></table>`:'<p class="empty">فروشی ثبت نشده است.</p>'}
async function printReceipt(id){try{await window.hesabdari.receipt.print(id)}catch(e){toast(e.message)}}

async function loadSync(){
  try{
    const c=await window.hesabdari.sync.config();
    $('syncName').value=c?.name||'صندوق فروش'; $('syncUrl').value=c?.api_url||''; $('syncToken').value=''; $('syncToken').placeholder=c?.token_configured?'توکن ذخیره‌شده است — برای حفظ آن خالی بگذارید':'توکن API'; $('syncEnabled').value=c?.enabled?'1':'0';
    const st=await window.hesabdari.sync.status();
    $('syncStatus').innerHTML=`<b>${st.config?.enabled?'🟢 فعال':'⚪ غیرفعال'}</b> · صف ارسال: <b>${fmt(st.pending)}</b> · تعارض باز: <b>${fmt(st.conflicts)}</b>`;
    $('syncDevice').innerHTML=`شناسه دستگاه: <code>${esc(c?.device_id||'-')}</code><br>آخرین ارسال: ${c?.last_push_at?new Date(c.last_push_at).toLocaleString('fa-IR'):'—'} · آخرین دریافت: ${c?.last_pull_at?new Date(c.last_pull_at).toLocaleString('fa-IR'):'—'}${c?.last_error?`<br><span class="low">خطا: ${esc(c.last_error)}</span>`:''}`;
    $('syncOutbox').innerHTML=st.lastChanges?.length?`<table><thead><tr><th>نوع</th><th>عملیات</th><th>وضعیت</th><th>خطا</th><th>زمان</th></tr></thead><tbody>${st.lastChanges.map(x=>`<tr><td>${esc(x.entity_type)}</td><td>${esc(x.operation)}</td><td>${esc(x.status)}</td><td>${esc(x.last_error||'-')}</td><td>${new Date(x.updated_at).toLocaleString('fa-IR')}</td></tr>`).join('')}</tbody></table>`:'<p class="empty">صف تغییراتی وجود ندارد.</p>';
    await loadSyncConflicts();
  }catch(e){toast(e.message)}
}
async function saveSyncConfig(){try{const r=await window.hesabdari.sync.setConfig({name:$('syncName').value.trim(),apiUrl:$('syncUrl').value.trim(),apiToken:$('syncToken').value.trim(),enabled:$('syncEnabled').value==='1'});$('syncConfigResult').innerHTML=`ذخیره شد · شناسه دستگاه: <code>${esc(r.device_id)}</code>`;await loadSync();toast('تنظیمات آمیما ذخیره شد')}catch(e){toast(e.message)}}
async function runSync(){try{const r=await window.hesabdari.sync.run();toast(`همگام‌سازی انجام شد · ارسال ${fmt(r.pushed)} · دریافت ${fmt(r.pulled)} · تعارض ${fmt(r.conflicts)}`);await loadSync()}catch(e){toast(e.message);await loadSync()}}
async function loadSyncConflicts(){const list=await window.hesabdari.sync.conflicts();$('syncConflicts').innerHTML=list.length?`<table><thead><tr><th>نوع</th><th>شناسه</th><th>نسخه محلی</th><th>نسخه سرور</th><th>عملیات</th></tr></thead><tbody>${list.map(x=>`<tr><td>${esc(x.entity_type)}</td><td><code>${esc(x.entity_id)}</code></td><td>${fmt(x.local_version)}</td><td>${fmt(x.server_version)}</td><td><button onclick="resolveSyncConflict('${x.id}','KEEP_LOCAL')">حفظ محلی</button> <button onclick="resolveSyncConflict('${x.id}','KEEP_SERVER')">حفظ سرور</button></td></tr>`).join('')}</tbody></table>`:'<p class="empty">تعارضی ثبت نشده است.</p>'}
async function resolveSyncConflict(id,resolution){if(!confirm(resolution==='KEEP_LOCAL'?'نسخه محلی حفظ شود؟':'نسخه سرور جایگزین شود؟'))return;try{await window.hesabdari.sync.resolve({id,resolution});toast('تعارض تعیین تکلیف شد');await loadSync()}catch(e){toast(e.message)}}

async function loadBackup(){try{const st=await window.hesabdari.backup.settings();$('autoBackupEnabled').value=st.enabled?'1':'0';$('autoBackupHours').value=st.intervalHours;await runHealthCheck();await loadBackupList()}catch(e){toast(e.message)}}
async function makeBackup(){try{const p=await window.hesabdari.backup.create();if(!p)return;$('backupResult').innerHTML=`<p class="backup-ok">پشتیبان ایجاد شد:<br><b>${esc(p)}</b></p>`;await loadBackupList()}catch(e){toast(e.message)}}
async function makeAutoBackup(){try{const p=await window.hesabdari.backup.createAuto();$('backupResult').innerHTML=p?`<p class="backup-ok">پشتیبان خودکار ایجاد شد:<br><b>${esc(p)}</b></p>`:'پشتیبان خودکار غیرفعال است';await loadBackupList()}catch(e){toast(e.message)}}
async function restoreBackup(){if(!confirm('بازیابی انجام شود؟ اطلاعات فعلی با فایل پشتیبان جایگزین می‌شود.'))return;try{const r=await window.hesabdari.backup.restore();if(!r)return;toast('بازیابی با موفقیت انجام شد');await loadProducts();await loadBackup();go('dashboard')}catch(e){toast(e.message)}}
async function saveBackupSettings(){try{const r=await window.hesabdari.backup.setSettings({enabled:$('autoBackupEnabled').value==='1',intervalHours:Number($('autoBackupHours').value)});$('backupSettingsResult').textContent=`ذخیره شد · هر ${r.intervalHours} ساعت`;toast('تنظیمات پشتیبان ذخیره شد')}catch(e){toast(e.message)}}
async function runFullIntegrity(){try{const r=await window.hesabdari.integrity.full();const rows=r.checks.map(x=>`<div>${x.ok?'✅':'❌'} <b>${esc(x.label)}</b> — ${esc(x.details)}</div>`).join('');$('healthResult').innerHTML=`<b>${r.ok?'✅ تست جامع با موفقیت PASS شد':'❌ تست جامع FAIL شد'}</b><br>${rows}<div class="tier-hint">زمان: ${new Date(r.checkedAt).toLocaleString('fa-IR')}</div>`;}catch(e){$('healthResult').textContent=e.message}}
async function runHealthCheck(){try{const h=await window.hesabdari.backup.health();const mismatch=h.stockMismatches?.length||0;$('healthResult').innerHTML=`<b>${h.ok?'✅ پایگاه داده سالم است':'⚠️ نیاز به بررسی دارد'}</b><br>Integrity: ${esc(h.integrity)} · خطای Foreign Key: ${fmt(h.foreignKeyErrors)} · مغایرت موجودی: ${fmt(mismatch)}<br>حجم فایل: ${fmt(Math.round(h.fileSize/1024))} KB<br>آخرین بررسی: ${new Date(h.checkedAt).toLocaleString('fa-IR')}${mismatch?`<br><span class="low">موجودی ثبت‌شده ${fmt(mismatch)} کالا با جمع گردش انبار یکسان نیست.</span>`:''}`}catch(e){$('healthResult').textContent=e.message}}
async function loadBackupList(){const list=await window.hesabdari.backup.list();$('backupList').innerHTML=list.length?`<table><thead><tr><th>فایل</th><th>حجم</th><th>اعتبار</th><th>زمان</th></tr></thead><tbody>${list.map(x=>`<tr><td>${esc(x.name)}</td><td>${fmt(Math.round(x.size/1024))} KB</td><td>${x.verified?'✅ معتبر':'⚠️ نیاز به بررسی'}</td><td>${new Date(x.modifiedAt).toLocaleString('fa-IR')}</td></tr>`).join('')}</tbody></table>`:'<p class="empty">پشتیبان محلی وجود ندارد.</p>'}
document.querySelectorAll('#nav button').forEach(b=>b.onclick=()=>go(b.dataset.page));window.addEventListener('DOMContentLoaded',bootAuth);

document.addEventListener('keydown',e=>{if(e.key==='F2'){e.preventDefault();go('sales');setTimeout(()=>document.getElementById('qName')?.focus(),50)}else if(e.key==='F4'){e.preventDefault();if(currentPage==='sales')newInvoice()}else if(e.key==='F8'){e.preventDefault();if(currentPage==='sales')openPayment()}else if(e.key==='Escape'){if(!$('modal').classList.contains('hidden'))closeModal()}});


const PAGE_PERMISSION={dashboard:'dashboard.view',sales:'sales.create',products:'products.manage',inventory:'inventory.manage',reports:'reports.view',customers:'customers.manage',cash:'cash.manage',accounting:'accounting.view',audit:'audit.view',backup:'backup.create',sync:'sync.manage',users:'users.manage',purchases:'inventory.manage'};
let session=null;
function applySession(){
  const permissions=Array.isArray(session?.permissions)?session.permissions:[];
  $("sessionUser").textContent=session?`${session.displayName} · ${session.roleDisplayName}`:"—";
  document.querySelectorAll("#nav button").forEach(b=>{const perm=PAGE_PERMISSION[b.dataset.page];b.classList.toggle("hidden",!!perm&&!permissions.includes(perm));});
  $("page-users")?.classList.toggle("hidden",!permissions.includes("users.manage"));
  $("loginOverlay").classList.toggle("hidden",!!session);
}
async function bootAuth(){
  try{session=await window.hesabdari.auth.current();if(!session){applySession();$('loginUsername').focus();return;}applySession();go('dashboard');}
  catch(e){$('loginError').textContent=e.message||'خطا در ورود';}
}
async function login(){
  const username=$('loginUsername').value.trim(),password=$('loginPassword').value;
  $('loginError').textContent='';
  try{session=await window.hesabdari.auth.login({username,password});$('loginPassword').value='';applySession();go('dashboard');toast(`خوش آمدید ${session.displayName}`);}catch(e){$('loginError').textContent=e.message||'ورود ناموفق بود';}
}
async function logout(){try{await window.hesabdari.auth.logout();session=null;applySession();$('loginPassword').value='';$('loginUsername').focus();}catch(e){toast(e.message)}}
function go(page){
  if(session && PAGE_PERMISSION[page] && !session.permissions.includes(PAGE_PERMISSION[page])){toast('دسترسی شما به این بخش مجاز نیست');return;}
  if(!session)return;
  currentPage=page;document.querySelectorAll('.page').forEach(x=>x.classList.add('hidden'));const target=$('page-'+page);if(!target)return;target.classList.remove('hidden');document.querySelectorAll('#nav button').forEach(x=>x.classList.toggle('active',x.dataset.page===page));
  if(page==='dashboard')loadDashboard();if(page==='sales')loadSales();if(page==='products'){loadProducts().then(()=>{renderProducts();loadPriceHistory()})}if(page==='inventory')loadInventory();if(page==='reports')loadReports();if(page==='customers')loadCustomers();if(page==='cash')loadCash();if(page==='accounting')loadAccounting();if(page==='audit')loadAudit();if(page==='backup')loadBackup();if(page==='sync')loadSync();if(page==='users')loadUsers();
}
async function loadUsers(){try{const list=await window.hesabdari.users.list();$('usersTable').innerHTML=list.length?`<table><thead><tr><th>نام کاربری</th><th>نام</th><th>نقش</th><th>وضعیت</th><th>عملیات</th></tr></thead><tbody>${list.map(u=>`<tr><td><b>${esc(u.username)}</b></td><td>${esc(u.display_name)}</td><td>${esc(u.role_display_name)}</td><td>${u.active?'فعال':'غیرفعال'}</td><td><button onclick="toggleUser('${u.id}',${u.active?0:1})">${u.active?'غیرفعال کردن':'فعال کردن'}</button> <button onclick="resetUserPassword('${u.id}','${esc(u.username)}')">بازنشانی رمز</button></td></tr>`).join('')}</tbody></table>`:'<p class="empty">کاربری وجود ندارد.</p>';}catch(e){toast(e.message)}}
async function createUser(){try{const r=await window.hesabdari.users.create({username:$('newUserName').value,displayName:$('newUserDisplay').value,password:$('newUserPassword').value,roleName:$('newUserRole').value});$('userCreateResult').textContent=`کاربر ${r.username} ایجاد شد.`;$('newUserPassword').value='';$('newUserName').value='';$('newUserDisplay').value='';await loadUsers();toast('کاربر ایجاد شد')}catch(e){$('userCreateResult').textContent=e.message}}
async function toggleUser(id,active){try{await window.hesabdari.users.setActive({userId:id,active:!!active});await loadUsers();toast(active?'کاربر فعال شد':'کاربر غیرفعال شد')}catch(e){toast(e.message)}}
async function resetUserPassword(id,username){const password=prompt(`رمز جدید برای ${username} (حداقل ۶ کاراکتر):`);if(password===null)return;try{await window.hesabdari.users.setPassword({userId:id,password});toast('رمز عبور تغییر کرد')}catch(e){toast(e.message)}}
async function changeMyPassword(){if(!session)return;const password=prompt('رمز عبور جدید (حداقل ۶ کاراکتر):');if(password===null)return;try{await window.hesabdari.users.setPassword({userId:session.id,password});toast('رمز عبور شما تغییر کرد')}catch(e){toast(e.message)}}
document.addEventListener('keydown',e=>{if((e.key==='Enter'||e.keyCode===13||e.which===13)&&document.activeElement?.id==='loginUsername'){e.preventDefault();e.stopPropagation();$('loginPassword').focus();}else if((e.key==='Enter'||e.keyCode===13||e.which===13)&&document.activeElement?.id==='loginPassword'){e.preventDefault();e.stopPropagation();login();}},true);

















































