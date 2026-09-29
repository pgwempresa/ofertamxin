const {createHmac,timingSafeEqual}=require('node:crypto');
const p=require('../lib/mexico');
module.exports=async(req,res)=>{
 res.setHeader('Cache-Control','no-store');
 if(req.method!=='POST')return res.status(405).json({erro:'Método no permitido.'});
 try{
  const secret=process.env.STRIPE_WEBHOOK_SECRET;if(!secret)throw new p.PaymentError('Webhook no configurado.',503);
  const chunks=[];let size=0;for await(const chunk of req){size+=Buffer.byteLength(chunk);if(size>262144)throw new p.PaymentError('Solicitud demasiado grande.',413);chunks.push(Buffer.from(chunk))}
  const raw=Buffer.concat(chunks),parts=String(req.headers['stripe-signature']||'').split(',').map(x=>x.split('='));
  const time=parts.find(x=>x[0]==='t')?.[1];
  if(!/^\d+$/.test(time||'')||Math.abs(Date.now()/1000-Number(time))>300)throw new p.PaymentError('Firma no válida.',400);
  const expected=createHmac('sha256',secret).update(time+'.').update(raw).digest();
  const valid=parts.filter(x=>x[0]==='v1'&&/^[a-f0-9]{64}$/i.test(x[1]||'')).some(x=>timingSafeEqual(expected,Buffer.from(x[1],'hex')));
  if(!valid)throw new p.PaymentError('Firma no válida.',400);
  const event=JSON.parse(raw.toString());
  if(!['checkout.session.completed','checkout.session.async_payment_succeeded','checkout.session.expired'].includes(event.type))return res.status(200).json({ok:true,ignored:true});
  const session=event.data?.object,order=await p.getOrder(session?.metadata?.order_id||'');
  if(order.provider!=='stripe')throw new p.PaymentError('Proveedor no válido.');
  if(!order.provider_id)throw new p.PaymentError('Pedido todavía no registrado.',503);
  if(session.id!==order.provider_id)throw new p.PaymentError('Pedido no válido.');
  await p.reconcile(order);return res.status(200).json({ok:true});
 }catch(e){return res.status(e instanceof p.PaymentError?e.status:400).json({erro:e instanceof p.PaymentError?e.message:'Webhook no válido.'})}
};
module.exports.config={api:{bodyParser:false}};
