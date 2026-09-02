const $=id=>document.getElementById(id)
const escapeHtml=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]))
async function readJson(url){const response=await fetch(url,{cache:'no-store'});if(!response.ok)throw new Error(`读取失败 ${response.status}`);return response.json()}
async function load(){
  $('refresh').disabled=true
  try{
    const bucket=$('bucket').value
    const [status,products]=await Promise.all([readJson('/api/status'),readJson(`/api/products${bucket?`?bucket=${bucket}`:''}`)])
    for(const key of ['reusable','nonReusableHot','staging','safety'])$(key).textContent=status.counts[key]??0
    $('integrity').textContent=`数据库完整性：${status.integrity==='ok'?'正常':status.integrity}`
    $('sources').innerHTML=(status.sources||[]).map(source=>`<div class="source"><strong>${escapeHtml(source.source_id)}</strong><br><span>${escapeHtml(source.status)} · 本轮 ${escapeHtml(source.records_last_run)} 条</span></div>`).join('')||'<p class="empty">还没有来源运行记录。</p>'
    $('products').innerHTML=products.length?products.map(product=>`<article class="product"><h3>${escapeHtml(product.name)}</h3><div class="badges"><span class="badge ${product.bucket==='REUSABLE'?'good':'warn'}">${product.bucket==='REUSABLE'?'可复用':'高热研究'}</span><span class="badge">热度 ${escapeHtml(product.heat)}</span><span class="badge">完整度 ${escapeHtml(product.completeness)}%</span><span class="badge">可信度 ${escapeHtml(product.confidence)}</span><span class="badge">独立公开地址 ${escapeHtml(product.evidenceCount)} 个</span>${product.observationCount!==product.evidenceCount?`<span class="badge">采集观察 ${escapeHtml(product.observationCount)} 条</span>`:''}<span class="badge">${escapeHtml(product.ageBand)}</span></div><p class="reason">${escapeHtml(product.reason)}</p>${product.publicUrl?`<a class="source-link" href="${escapeHtml(product.publicUrl)}" target="_blank" rel="noopener noreferrer">打开公开商品／研究页</a>`:'<span class="no-link">暂无公开商品页，只保留其它研究证据</span>'}</article>`).join(''):'<p class="empty">当前没有符合正式库门槛的商品。系统不会为了凑数而降低标准。</p>'
  }catch(error){$('products').innerHTML=`<p class="empty">${escapeHtml(error.message)}</p>`}finally{$('refresh').disabled=false}
}
$('refresh').addEventListener('click',load);$('bucket').addEventListener('change',load);load();setInterval(load,30000)
