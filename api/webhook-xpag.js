const p=require('../lib/mexico');
module.exports=p.route(async req=>{
 const b=p.input(req);
 if(b.type!=='cashin'||b.currency!=='MXN')return {ok:true,ignored:true};
 const id=p.text(b.transaction_id||b.request_number,180);
 if(!id)throw new p.PaymentError('Identificador ausente.');
 const rows=await p.db('payment_orders?provider=eq.xpag&provider_id=eq.'+encodeURIComponent(id)+'&select=*');
 if(!rows[0])throw new p.PaymentError('Pedido todavía no registrado. Reintenta más tarde.',503);
 // Public docs specify no signature header. Never trust the webhook status:
 // query XPag with private credentials and compare ID, amount and currency.
 await p.reconcile(rows[0]);return {ok:true};
});
