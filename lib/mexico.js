'use strict';
const {randomUUID}=require('node:crypto');
const PRICES={base:150,discount:50,checkoutRecoveryDiscount:50,colorir:50,expressa:30,extras:70,upsellFamiliar:200,upsellDownsell:200};
class PaymentError extends Error{constructor(message,status=400,uncertain=false){super(message);this.status=status;this.uncertain=uncertain}}
const text=(v,max=180)=>typeof v==='string'?v.trim().slice(0,max):'';
const cents=v=>Math.round(Number(v)*100);
function sign(data){return Buffer.from(JSON.stringify(data)).toString('base64url')}
function verify(token){
 const raw=String(token||'');if(!raw||raw.length>3000)throw new PaymentError('Enlace de pago no válido.',403);
 let d;try{d=JSON.parse(Buffer.from(raw,'base64url'))}catch{throw new PaymentError('Enlace de pago no válido.',403)}
 if(!Number.isFinite(d.exp)||d.exp<Date.now()||d.scope!=='payment_status')throw new PaymentError('El enlace venció. Contacta a soporte.',403);return d;
}
function token(order){return sign({scope:'payment_status',id:order.id,exp:Date.now()+7*86400000})}
function input(req){let b;try{b=typeof req.body==='string'?JSON.parse(req.body):req.body}catch{throw new PaymentError('Solicitud no válida.')};if(!b||typeof b!=='object'||Array.isArray(b)||Buffer.byteLength(JSON.stringify(b))>40000)throw new PaymentError('Solicitud no válida.');return b}
function site(){const raw=process.env.PUBLIC_SITE_URL;let u;try{u=new URL(raw)}catch{throw new PaymentError('El pago todavía no está configurado.',503)};if(u.protocol!=='https:'&&!(process.env.NODE_ENV!=='production'&&['localhost','127.0.0.1'].includes(u.hostname)))throw new PaymentError('El sitio de pago requiere HTTPS.',503);return u.origin}
function total(b){return b.upsellFamiliar===true?PRICES.upsellFamiliar+(b.obExtras===true?PRICES.extras:0):PRICES.base-PRICES.discount+(b.addon_colorir===true?PRICES.colorir:0)+(b.addon_expressa===true?PRICES.expressa:0)+(b.obExtras===true?PRICES.extras:0)}
function orderInput(b,provider,method){
 site();
 const name=text(b.name||b.quizData?.mom_name),email=text(b.email).toLowerCase();
 const phone=text(b.telefone,30).replace(/\D/g,'');
 if(!name||!/^\S+@\S+\.\S+$/.test(email))throw new PaymentError('Ingresa tu nombre y un correo electrónico válido.');
 if(!/^(?:52)?\d{10}$/.test(phone))throw new PaymentError('Ingresa un teléfono mexicano de 10 dígitos.');
 if(!/^[A-Za-z0-9_-]{8,120}$/.test(b.identifier||''))throw new PaymentError('Actualiza la página antes de pagar.');
 const amount=total(b);if(!Number.isFinite(Number(b.total))||Number(b.total)!==amount)throw new PaymentError('El precio cambió. Actualiza la página.',409);
 const document=text(b.document,18).toUpperCase().replace(/\s/g,'');
 const flags={upsellFamiliar:b.upsellFamiliar===true,addon_colorir:b.upsellFamiliar!==true&&b.addon_colorir===true,addon_expressa:b.upsellFamiliar!==true&&b.addon_expressa===true,obExtras:b.obExtras===true};
 const id='mx_'+randomUUID().replace(/-/g,'');
 const quiz=b.quizData&&typeof b.quizData==='object'&&!Array.isArray(b.quizData)?b.quizData:{};
 return {id,provider,payment_method:method,amount_cents:cents(amount),currency:'MXN',status:'creating',email,guardian_name:name,phone:phone.length===10?'52'+phone:phone,checkout_mode:flags.upsellFamiliar?'upsell':'main',quiz_data:{...quiz,locale:'es-MX',upsellData:b.upsellData||{},...flags},document};
}
const orders=globalThis.__mxOrders||(globalThis.__mxOrders=new Map());
async function db(){return []}
async function getOrder(id){const order=orders.get(id);if(!order)throw new PaymentError('Pedido no encontrado.',404);return order}
async function reserve(order){
 const {document,...saved}=order;
 if(orders.has(order.id))return {fresh:false,order:orders.get(order.id)}; orders.set(order.id,{...saved,created_at:new Date().toISOString()}); return {fresh:true,order:orders.get(order.id)};
}
async function update(id,patch){const order=await getOrder(id);const next={...order,...patch,updated_at:new Date().toISOString()};orders.set(id,next);return next}
async function providerRequest(url,options={}){
 let r;try{r=await fetch(url,{...options,signal:AbortSignal.timeout(15000)})}catch{throw new PaymentError('No pudimos confirmar la respuesta del proveedor. Verifica el pedido antes de volver a pagar.',502,true)}
 let d;try{d=await r.json()}catch{throw new PaymentError('El proveedor no respondió correctamente. Contacta a soporte.',502,true)}
 if(!r.ok||d.ok===false||d.error){
  const stripe=url.includes('stripe.com');
  const provider=stripe?'Stripe':'XPag';
  const detail=d.error?.message||d.error?.description||d.message||d.detail||d.erro;
  if(stripe)console.error('stripe_error',{status:r.status,type:d.error?.type,code:d.error?.code,param:d.error?.param,message:detail});
  throw new PaymentError(provider+' no pudo procesar la solicitud'+(detail?': '+detail:'')+'.',stripe&&r.status<500?400:502,true);
 }
 return d;
}
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function xpagHeaders(){const id=process.env.XPAG_CLIENT_ID,key=process.env.XPAG_CLIENT_SECRET;if(!id||!key)throw new PaymentError('SPEI todavía no está configurado.',503);return {'Content-Type':'application/json','X-Client-Id':id,'X-Client-Secret':key}}
function stripeHeaders(){const key=process.env.STRIPE_SECRET_KEY;if(!key)throw new PaymentError('El pago con tarjeta todavía no está configurado.',503);return {Authorization:'Bearer '+key,'Content-Type':'application/x-www-form-urlencoded'}}
function response(order){return {id:order.id,total:order.amount_cents/100,currency:'MXN',status:order.status,statusToken:token(order),checkoutMode:order.checkout_mode,paymentMethod:order.payment_method,...(order.payment_method==='spei'?{spei:order.payment_data}:order.payment_method==='oxxo'?{oxxo:order.payment_data}:{url:order.payment_data?.url,clientSecret:order.payment_data?.clientSecret,publishableKey:order.payment_data?.publishableKey})}}
async function create(b,provider,method=provider==='stripe'?'card':'spei'){
 const headers=provider==='xpag'?xpagHeaders():stripeHeaders();
 const proposed=orderInput(b,provider,method),reserved=await reserve(proposed),order=reserved.order;
 if(!reserved.fresh){if(['pending','approved'].includes(order.status)&&order.provider_id)return response(order);throw new PaymentError('Este pedido ya se está procesando. Contacta a soporte antes de volver a pagar.',409,true)}
 try{
  let d,providerId,paymentData;
  if(provider==='xpag'){
   const payload={currency:'MXN',amount:order.amount_cents/100,description:order.checkout_mode==='upsell'?'Tu Cuentito — familia':'Tu Cuentito — libro personalizado',external_id:order.id,webhook_url:site()+'/api/webhook-xpag'};
   if(method==='oxxo')Object.assign(payload,{method:'OXXO',generateCheckout:false,payerData:{name:order.guardian_name,email:order.email}});
   else Object.assign(payload,{name:order.guardian_name});
   d=await providerRequest('https://api.xpag.global/cashin',{method:'POST',headers,body:JSON.stringify(payload)});
   providerId=d.transaction_id||d.request_number;
   const responseCurrency=String(d.currency||d.data?.currency||'').toUpperCase();
   const responseAmount=d.amount??d.data?.amount;
   if(!providerId||(responseCurrency&&responseCurrency!=='MXN')||(responseAmount!=null&&cents(responseAmount)!==order.amount_cents))throw new PaymentError('La respuesta de XPag no coincide (campos: '+Object.keys(d).join(',')+', moneda: '+(responseCurrency||'ausente')+', importe: '+(responseAmount??'ausente')+').',502,true);
   const containers=()=>[d,d.data,d.payee_data,d.spei,d.payment_data].filter(x=>x&&typeof x==='object');
   const findField=(names)=>{
    const wanted=new Set(names),seen=new Set();
    const walk=value=>{
     if(!value||typeof value!=='object'||seen.has(value))return null; seen.add(value);
     for(const [key,val] of Object.entries(value)){
      if(wanted.has(key)&&val!=null&&val!=='')return val;
      const nested=walk(val);if(nested!=null)return nested;
     }
     return null;
    };
    return walk(d);
   };
   const oxxoReady=()=>Boolean(findField(['reference','payment_reference','voucher_reference'])&&findField(['barcode','barcode_url','bar_code']));
   const speiReady=()=>Boolean(findField(['clabe','clabe_number','account_number'])&&findField(['bank_name','bank','bankName'])&&findField(['beneficiary','account_name','accountName'])&&findField(['reference','payment_reference','paymentReference','voucher_reference','voucherReference']));
   if((method==='spei'&&!speiReady())||(method==='oxxo'&&!oxxoReady())){
    for(let attempt=0;attempt<12;attempt++){
     await wait(1000);
     try{
      const current=await providerRequest('https://api.xpag.global/consult-transaction?transaction_id='+encodeURIComponent(providerId),{headers});
      if(current) d={...d,...current};
      if((method==='spei'&&speiReady())||(method==='oxxo'&&oxxoReady()))break;
     }catch{}
    }
   }
   const created=new Date(order.created_at||Date.now()).getTime();
   if(method==='oxxo'){
    let barcode;try{barcode=new URL(findField(['barcode','barcode_url','bar_code']))}catch{}
    const reference=findField(['reference','payment_reference','voucher_reference']);
    if(!reference||barcode?.protocol!=='https:')throw new PaymentError('No recibimos el comprobante OXXO de XPag (campos: '+Object.keys(d).join(',')+').',502,true);
    paymentData={reference:String(reference),barcode:barcode.href,expiresAt:new Date(created+12*86400000).toISOString()};
   }else{
    const clabe=String(findField(['clabe','clabe_number','account_number'])||findField(['copy_paste','copyPaste','code'])||'');
    const bank=String(findField(['bank_name','bank','bankName'])||'XPag');
    const beneficiary=String(findField(['beneficiary','account_name','accountName'])||'XPag');
    const reference=findField(['reference','payment_reference','paymentReference','voucher_reference','voucherReference'])||findField(['code','copy_paste','copyPaste'])||providerId;
    paymentData={clabe,reference:String(reference),bank:String(bank),beneficiary:String(beneficiary),expiresAt:new Date(created+86400000).toISOString()};
   }
  }else{
   const publishableKey=process.env.STRIPE_PUBLISHABLE_KEY||process.env.PUBLIC_STRIPE_PUBLISHABLE_KEY;
   if(!publishableKey||!/^pk_(test|live)_/.test(publishableKey))throw new PaymentError('La clave pública de Stripe todavía no está configurada. Agrega STRIPE_PUBLISHABLE_KEY con la clave pk_live.',503);
   const form=new URLSearchParams({mode:'payment',locale:'es-419',ui_mode:'embedded_page',redirect_on_completion:'if_required','payment_method_types[0]':'card',customer_email:order.email,client_reference_id:order.id,'metadata[order_id]':order.id,'payment_intent_data[metadata][order_id]':order.id,'line_items[0][price_data][currency]':'mxn','line_items[0][price_data][unit_amount]':String(order.amount_cents),'line_items[0][price_data][product_data][name]':order.checkout_mode==='upsell'?'Tu Cuentito — extra familiar':'Tu Cuentito — pedido personalizado','line_items[0][quantity]':'1',return_url:site()+'/?stripe=success&payment='+encodeURIComponent(token(order))+'&session_id={CHECKOUT_SESSION_ID}'});
   d=await providerRequest('https://api.stripe.com/v1/checkout/sessions',{method:'POST',headers:{...headers,'Idempotency-Key':order.id},body:form.toString()});providerId=d.id;
   if(!providerId||!d.client_secret)throw new PaymentError('Stripe no devolvió una sesión embebida válida.',502,true);
   paymentData={clientSecret:d.client_secret,publishableKey};
  }
  return response(await update(order.id,{provider_id:providerId,payment_data:paymentData,status:'pending'}));
 }catch(e){try{await update(order.id,{status:'uncertain'})}catch{};throw e}
}
async function reconcile(order){
 if(!order.provider_id)throw new PaymentError('El pedido sigue en revisión. Contacta a soporte.',409,true);
 let d,status='pending';
 if(order.provider==='xpag'){
  d=await providerRequest('https://api.xpag.global/consult-transaction?transaction_id='+encodeURIComponent(order.provider_id),{headers:xpagHeaders()});
  if(d.type!=='cashin'||(d.transaction_id!==order.provider_id&&d.request_number!==order.provider_id)||d.currency!=='MXN'||cents(d.amount)!==order.amount_cents)throw new PaymentError('Los datos del pago no coinciden con el pedido.',409);
  if(d.status==='confirmed')status='approved';else if(['expired','failed','refunded','canceled','med'].includes(d.status))status=d.status;
 }else{
  d=await providerRequest('https://api.stripe.com/v1/checkout/sessions/'+encodeURIComponent(order.provider_id),{headers:stripeHeaders()});
  if(d.id!==order.provider_id||d.client_reference_id!==order.id||d.currency!=='mxn'||d.amount_total!==order.amount_cents)throw new PaymentError('Los datos del pago no coinciden con el pedido.',409);
  if(d.payment_status==='paid'&&d.status==='complete')status='approved';else if(d.status==='expired')status='expired';
 }
 // Ignore out-of-order pending notifications after a confirmed payment.
 if(order.status==='approved'&&status==='pending')status='approved';
 if(status!==order.status)order=await update(order.id,{status,...(status==='approved'?{paid_at:new Date().toISOString()}: {})});
 return order;
}
function route(fn){return async(req,res)=>{res.setHeader('Cache-Control','no-store');if(req.method!=='POST'){res.setHeader('Allow','POST');return res.status(405).json({erro:'Método no permitido.'})}try{if(req.headers.origin&&new URL(req.headers.origin).host!==req.headers.host)throw new PaymentError('Origen no permitido.',403);return res.status(200).json(await fn(req))}catch(e){return res.status(e instanceof PaymentError?e.status:500).json({erro:e instanceof PaymentError?e.message:'No pudimos procesar el pedido.',uncertain:e.uncertain===true})}}}
module.exports={PRICES,PaymentError,text,cents,sign,verify,token,input,site,total,orderInput,db,getOrder,reserve,update,create,response,reconcile,route};
