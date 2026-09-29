'use strict';
const {createHmac,timingSafeEqual}=require('node:crypto');
const PRICES={base:150,discount:50,checkoutRecoveryDiscount:50,colorir:50,expressa:30,extras:70,upsellFamiliar:200,upsellDownsell:200};
class PaymentError extends Error{constructor(message,status=400,uncertain=false){super(message);this.status=status;this.uncertain=uncertain}}
const text=(v,max=180)=>typeof v==='string'?v.trim().slice(0,max):'';
const cents=v=>Math.round(Number(v)*100);
function secret(){const s=process.env.PAYMENT_SIGNING_SECRET;if(!s||s.length<32)throw new PaymentError('El pago todavía no está configurado. Contacta a soporte.',503);return s}
function sign(data){const raw=Buffer.from(JSON.stringify(data)).toString('base64url');return raw+'.'+createHmac('sha256',secret()).update(raw).digest('base64url')}
function verify(token){
 const [raw,sig,...rest]=String(token||'').split('.');
 if(!raw||!sig||rest.length||raw.length>3000)throw new PaymentError('Enlace de pago no válido.',403);
 const expected=createHmac('sha256',secret()).update(raw).digest(),actual=Buffer.from(sig,'base64url');
 if(actual.length!==expected.length||!timingSafeEqual(actual,expected))throw new PaymentError('Enlace de pago no válido.',403);
 let d;try{d=JSON.parse(Buffer.from(raw,'base64url'))}catch{throw new PaymentError('Enlace de pago no válido.',403)}
 if(!Number.isFinite(d.exp)||d.exp<Date.now()||d.scope!=='payment_status')throw new PaymentError('El enlace venció. Contacta a soporte.',403);return d;
}
function token(order){return sign({scope:'payment_status',id:order.id,exp:Date.now()+7*86400000})}
function input(req){let b;try{b=typeof req.body==='string'?JSON.parse(req.body):req.body}catch{throw new PaymentError('Solicitud no válida.')};if(!b||typeof b!=='object'||Array.isArray(b)||Buffer.byteLength(JSON.stringify(b))>40000)throw new PaymentError('Solicitud no válida.');return b}
function site(){const raw=process.env.PUBLIC_SITE_URL;let u;try{u=new URL(raw)}catch{throw new PaymentError('El pago todavía no está configurado.',503)};if(u.protocol!=='https:'&&!(process.env.NODE_ENV!=='production'&&['localhost','127.0.0.1'].includes(u.hostname)))throw new PaymentError('El sitio de pago requiere HTTPS.',503);return u.origin}
function total(b){return b.upsellFamiliar===true?PRICES.upsellFamiliar+(b.obExtras===true?PRICES.extras:0):PRICES.base-PRICES.discount+(b.addon_colorir===true?PRICES.colorir:0)+(b.addon_expressa===true?PRICES.expressa:0)+(b.obExtras===true?PRICES.extras:0)}
function orderInput(b,provider,method){
 secret();site();
 const name=text(b.name||b.quizData?.mom_name),email=text(b.email).toLowerCase();
 const phone=text(b.telefone,30).replace(/\D/g,'');
 if(!name||!/^\S+@\S+\.\S+$/.test(email))throw new PaymentError('Ingresa tu nombre y un correo electrónico válido.');
 if(!/^(?:52)?\d{10}$/.test(phone))throw new PaymentError('Ingresa un teléfono mexicano de 10 dígitos.');
 if(!/^[A-Za-z0-9_-]{8,120}$/.test(b.identifier||''))throw new PaymentError('Actualiza la página antes de pagar.');
 const amount=total(b);if(!Number.isFinite(Number(b.total))||Number(b.total)!==amount)throw new PaymentError('El precio cambió. Actualiza la página.',409);
 const document=text(b.document,18).toUpperCase().replace(/\s/g,'');
 // XPag documents a Mexican CURP in its MXN cash-in example. No Brazilian CPF mask.
 if(method==='spei'&&!/^[A-Z][AEIOUX][A-Z]{2}\d{6}[HM][A-Z]{5}[A-Z0-9]\d$/.test(document))throw new PaymentError('Ingresa una CURP válida de la persona responsable de la compra.');
 const flags={upsellFamiliar:b.upsellFamiliar===true,addon_colorir:b.upsellFamiliar!==true&&b.addon_colorir===true,addon_expressa:b.upsellFamiliar!==true&&b.addon_expressa===true,obExtras:b.obExtras===true};
 const id='mx_'+createHmac('sha256',secret()).update(JSON.stringify([b.identifier,provider,method,email,flags,amount])).digest('hex').slice(0,40);
 const quiz=b.quizData&&typeof b.quizData==='object'&&!Array.isArray(b.quizData)?b.quizData:{};
 return {id,provider,payment_method:method,amount_cents:cents(amount),currency:'MXN',status:'creating',email,guardian_name:name,phone:phone.length===10?'52'+phone:phone,checkout_mode:flags.upsellFamiliar?'upsell':'main',quiz_data:{...quiz,locale:'es-MX',upsellData:b.upsellData||{},...flags},document};
}
async function db(path,options={}){
 const url=process.env.SUPABASE_URL?.replace(/\/+$/,''),key=process.env.SUPABASE_SERVICE_ROLE_KEY;
 if(!url||!key)throw new PaymentError('El pago todavía no está configurado. Contacta a soporte.',503);
 let r;try{r=await fetch(url+'/rest/v1/'+path,{...options,headers:{apikey:key,Authorization:'Bearer '+key,'Content-Type':'application/json',Prefer:'return=representation',...options.headers},signal:AbortSignal.timeout(8000)})}catch{throw new PaymentError('No pudimos guardar el estado del pedido. Contacta a soporte.',503,true)}
 if(!r.ok)throw new PaymentError('No pudimos guardar el estado del pedido. Contacta a soporte.',503,true);
 try{return await r.json()}catch{throw new PaymentError('No pudimos leer el estado del pedido.',503,true)}
}
async function getOrder(id){const rows=await db('payment_orders?id=eq.'+encodeURIComponent(id)+'&select=*');if(!rows[0])throw new PaymentError('Pedido no encontrado.',404);return rows[0]}
async function reserve(order){
 const {document,...saved}=order;
 const rows=await db('payment_orders?on_conflict=id',{method:'POST',headers:{Prefer:'resolution=ignore-duplicates,return=representation'},body:JSON.stringify(saved)});
 if(rows[0])return {fresh:true,order:rows[0]};return {fresh:false,order:await getOrder(order.id)};
}
async function update(id,patch){const rows=await db('payment_orders?id=eq.'+encodeURIComponent(id),{method:'PATCH',body:JSON.stringify({...patch,updated_at:new Date().toISOString()})});if(!rows[0])throw new PaymentError('Pedido no encontrado.',404);return rows[0]}
async function providerRequest(url,options={}){
 let r;try{r=await fetch(url,{...options,signal:AbortSignal.timeout(15000)})}catch{throw new PaymentError('No pudimos confirmar la respuesta del proveedor. Verifica el pedido antes de volver a pagar.',502,true)}
 let d;try{d=await r.json()}catch{throw new PaymentError('El proveedor no respondió correctamente. Contacta a soporte.',502,true)}
 if(!r.ok||d.ok===false||d.error)throw new PaymentError('El proveedor no pudo procesar la solicitud. Contacta a soporte.',502,true);return d;
}
function xpagHeaders(){const id=process.env.XPAG_CLIENT_ID,key=process.env.XPAG_CLIENT_SECRET;if(!id||!key)throw new PaymentError('SPEI todavía no está configurado.',503);return {'Content-Type':'application/json','X-Client-Id':id,'X-Client-Secret':key}}
function stripeHeaders(){const key=process.env.STRIPE_SECRET_KEY;if(!key)throw new PaymentError('El pago con tarjeta todavía no está configurado.',503);return {Authorization:'Bearer '+key,'Content-Type':'application/x-www-form-urlencoded'}}
function response(order){return {id:order.id,total:order.amount_cents/100,currency:'MXN',status:order.status,statusToken:token(order),checkoutMode:order.checkout_mode,paymentMethod:order.payment_method,...(order.payment_method==='spei'?{spei:order.payment_data}:order.payment_method==='oxxo'?{oxxo:order.payment_data}:{url:order.payment_data?.url})}}
async function create(b,provider,method=provider==='stripe'?'card':'spei'){
 const headers=provider==='xpag'?xpagHeaders():stripeHeaders();
 const proposed=orderInput(b,provider,method),reserved=await reserve(proposed),order=reserved.order;
 if(!reserved.fresh){if(['pending','approved'].includes(order.status)&&order.provider_id)return response(order);throw new PaymentError('Este pedido ya se está procesando. Contacta a soporte antes de volver a pagar.',409,true)}
 try{
  let d,providerId,paymentData;
  if(provider==='xpag'){
   const payload={currency:'MXN',amount:order.amount_cents/100,description:order.checkout_mode==='upsell'?'Tu Cuentito — familia':'Tu Cuentito — libro personalizado',external_id:order.id,webhook_url:site()+'/api/webhook-xpag'};
   if(method==='oxxo')Object.assign(payload,{method:'OXXO',generateCheckout:false,payerData:{name:order.guardian_name,email:order.email}});
   else Object.assign(payload,{name:order.guardian_name,document:proposed.document});
   d=await providerRequest('https://api.xpag.global/cashin',{method:'POST',headers,body:JSON.stringify(payload)});
   providerId=d.transaction_id||d.request_number;
   if(!providerId||d.currency!=='MXN'||cents(d.amount)!==order.amount_cents)throw new PaymentError('La respuesta está incompleta. Contacta a soporte antes de volver a pagar.',502,true);
   const created=new Date(order.created_at||Date.now()).getTime();
   if(method==='oxxo'){
    let barcode;try{barcode=new URL(d.payee_data?.barcode)}catch{}
    if(!d.payee_data?.reference||barcode?.protocol!=='https:')throw new PaymentError('No recibimos el comprobante OXXO. Contacta a soporte antes de volver a pagar.',502,true);
    paymentData={reference:String(d.payee_data.reference),barcode:barcode.href,expiresAt:new Date(created+12*86400000).toISOString()};
   }else{
    if(!/^\d{18}$/.test(d.clabe||'')||!d.bank_name||!d.beneficiary||!d.reference)throw new PaymentError('La respuesta SPEI está incompleta. Contacta a soporte antes de volver a pagar.',502,true);
    paymentData={clabe:d.clabe,reference:String(d.reference),bank:String(d.bank_name),beneficiary:String(d.beneficiary),expiresAt:new Date(created+86400000).toISOString()};
   }
  }else{
   const form=new URLSearchParams({mode:'payment',locale:'es-419','payment_method_types[0]':'card',customer_email:order.email,client_reference_id:order.id,'metadata[order_id]':order.id,'payment_intent_data[metadata][order_id]':order.id,'line_items[0][price_data][currency]':'mxn','line_items[0][price_data][unit_amount]':String(order.amount_cents),'line_items[0][price_data][product_data][name]':order.checkout_mode==='upsell'?'Tu Cuentito — extra familiar':'Tu Cuentito — pedido personalizado','line_items[0][quantity]':'1',success_url:site()+'/?stripe=success&payment='+encodeURIComponent(token(order)),cancel_url:site()+'/?stripe=cancel&payment='+encodeURIComponent(token(order))});
   d=await providerRequest('https://api.stripe.com/v1/checkout/sessions',{method:'POST',headers:{...headers,'Idempotency-Key':order.id},body:form.toString()});providerId=d.id;
   let u;try{u=new URL(d.url)}catch{}
   if(!providerId||u?.hostname!=='checkout.stripe.com'||u.protocol!=='https:')throw new PaymentError('Stripe no devolvió un enlace de pago válido.',502,true);
   paymentData={url:d.url};
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
