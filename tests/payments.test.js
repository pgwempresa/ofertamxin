const {test,beforeEach,afterEach}=require('node:test');
const assert=require('node:assert/strict');
const {Readable}=require('node:stream');
const {createHmac}=require('node:crypto');
const fs=require('node:fs'),vm=require('node:vm');
const p=require('../lib/mexico');
const originalFetch=global.fetch;
let rows,calls,provider;
beforeEach(()=>{
 Object.assign(process.env,{PAYMENT_SIGNING_SECRET:'test-only-secret-with-more-than-32-characters',PUBLIC_SITE_URL:'https://store.example',SUPABASE_URL:'https://db.example',SUPABASE_SERVICE_ROLE_KEY:'test-db-secret',XPAG_CLIENT_ID:'test-client',XPAG_CLIENT_SECRET:'test-xpag-secret',STRIPE_SECRET_KEY:'sk_test_fake',STRIPE_WEBHOOK_SECRET:'whsec_test_fake'});
 rows=new Map();calls=[];provider=async()=>{throw Error('Unexpected provider request')};
 global.fetch=async(url,options={})=>{
  calls.push({url,options});
  if(url.startsWith('https://db.example/rest/v1/payment_orders')){
   const u=new URL(url),id=u.searchParams.get('id')?.slice(3),providerId=u.searchParams.get('provider_id')?.slice(3);
   if(options.method==='POST'){
    const data=JSON.parse(options.body);if(rows.has(data.id))return Response.json([]);
    rows.set(data.id,{...data,created_at:new Date().toISOString(),payment_data:{}});return Response.json([rows.get(data.id)]);
   }
   if(options.method==='PATCH'){if(!rows.has(id))return Response.json([]);rows.set(id,{...rows.get(id),...JSON.parse(options.body)});return Response.json([rows.get(id)])}
   return Response.json(id?(rows.has(id)?[rows.get(id)]:[]):[...rows.values()].filter(x=>x.provider_id===providerId));
  }
  return provider(url,options);
 };
});
afterEach(()=>{global.fetch=originalFetch;for(const k of ['PAYMENT_SIGNING_SECRET','PUBLIC_SITE_URL','SUPABASE_URL','SUPABASE_SERVICE_ROLE_KEY','XPAG_CLIENT_ID','XPAG_CLIENT_SECRET','STRIPE_SECRET_KEY','STRIPE_WEBHOOK_SECRET'])delete process.env[k]});
const body=(extra={})=>({identifier:'test-order-123',name:'Ana Pérez',email:'ana@example.com',telefone:'5512345678',document:'PEPJ800101HDFRRL09',total:100,quizData:{mom_name:'Ana Pérez',child_name:'Miguel'},...extra});
const spei=()=>({ok:true,transaction_id:'pr_spei',currency:'MXN',amount:100,clabe:'012345678901234567',reference:'REF123',bank_name:'STP',beneficiary:'Proveedor'});
async function call(fn,body,extra={}){let code,data;const req={method:'POST',headers:{host:'store.example',origin:'https://store.example'},body,...extra};await fn(req,{setHeader(){},status(n){code=n;return this},json(d){data=d}});return {code,data}}
test('preços finais e comparação 50% maior; todas as combinações calculadas no servidor',()=>{
 assert.equal(p.PRICES.base,150);assert.equal(p.total(body()),100);
 for(let bits=0;bits<8;bits++){
  const b=body({addon_colorir:!!(bits&1),addon_expressa:!!(bits&2),obExtras:!!(bits&4),hasDiscount:false,checkoutRecoveryOffer:true});
  assert.equal(p.total(b),100+(bits&1?50:0)+(bits&2?30:0)+(bits&4?70:0));
 }
 assert.equal(p.total(body({upsellFamiliar:true,upsellDownsell:true})),200);
 assert.equal(p.total(body({upsellFamiliar:true,obExtras:true})),270);
});
test('total adulterado, documento inválido e telefone inválido rejeitados antes de cobrar',async()=>{
 for(const extra of [{total:1},{document:'52998224725'},{telefone:'1'}])await assert.rejects(p.create(body(extra),'xpag'));
 assert.equal(calls.length,0);
});
test('SPEI usa credenciais privadas, valor em MXN e instruções completas; CURP não é persistida',async()=>{
 provider=async(url,o)=>{assert.equal(url,'https://api.xpag.global/cashin');assert.equal(o.headers['X-Client-Id'],'test-client');assert.equal(o.headers['X-Client-Secret'],'test-xpag-secret');const b=JSON.parse(o.body);assert.equal(b.amount,100);assert.equal(b.currency,'MXN');assert.equal(b.document,body().document);assert.equal(b.webhook_url,'https://store.example/api/webhook-xpag');return Response.json(spei())};
 const result=await p.create(body(),'xpag');assert.equal(result.spei.bank,'STP');assert.equal(result.spei.clabe,'012345678901234567');assert.equal(result.status,'pending');assert.equal(result.total,100);
 assert.ok(!JSON.stringify([...rows.values()]).includes(body().document));assert.ok(!JSON.stringify(result).includes('test-xpag-secret'));
});
test('reserva persistente impede duas cobranças para a mesma tentativa',async()=>{
 let charges=0;provider=async()=>{charges++;return Response.json(spei())};
 const first=await p.create(body(),'xpag'),second=await p.create(body(),'xpag');assert.equal(first.id,second.id);assert.equal(charges,1);
});
test('reserva bloqueia concorrência enquanto a operadora está processando',async()=>{
 let release;provider=async()=>{await new Promise(r=>{release=r});return Response.json(spei())};
 const first=p.create(body(),'xpag');await new Promise(r=>setImmediate(r));
 await assert.rejects(p.create(body(),'xpag'),e=>e.status===409&&e.uncertain);release();await first;
});
test('resposta ambígua preserva pedido e bloqueia repetição automática',async()=>{
 provider=async()=>{throw Error('network')};await assert.rejects(p.create(body(),'xpag'),e=>e.uncertain);assert.equal([...rows.values()][0].status,'uncertain');
 await assert.rejects(p.create(body(),'xpag'),e=>e.status===409);assert.equal(calls.filter(c=>c.url.includes('/cashin')).length,1);
});
test('sem banco de dados configurado, nenhuma cobrança é criada',async()=>{
 delete process.env.SUPABASE_SERVICE_ROLE_KEY;await assert.rejects(p.create(body(),'xpag'),e=>e.status===503);assert.equal(calls.length,0);
});
test('OXXO usa voucher bruto sem CURP, referência, código de barras e validade de 12 dias',async()=>{
 provider=async(url,o)=>{const b=JSON.parse(o.body);assert.equal(b.method,'OXXO');assert.equal(b.generateCheckout,false);assert.equal(b.payerData.email,'ana@example.com');assert.equal(b.document,undefined);return Response.json({ok:true,currency:'MXN',amount:100,transaction_id:'oxxo_1',payee_data:{reference:'123456789',barcode:'https://static.muwe.mx/barcode.png'}})};
 const result=await p.create(body({document:''}),'xpag','oxxo');assert.equal(result.paymentMethod,'oxxo');assert.equal(result.oxxo.reference,'123456789');assert.ok(Date.parse(result.oxxo.expiresAt)>Date.now()+11*86400000);
});
test('SPEI incompleto e voucher OXXO sem HTTPS falham sem repetição de cobrança',async()=>{
 provider=async()=>Response.json({...spei(),bank_name:''});await assert.rejects(p.create(body(),'xpag'),e=>e.uncertain);
 provider=async()=>Response.json({ok:true,transaction_id:'oxxo_1',currency:'MXN',amount:100,payee_data:{reference:'123',barcode:'javascript:alert(1)'}});
 await assert.rejects(p.create(body(),'xpag','oxxo'),e=>e.uncertain);
});
test('Stripe cria Checkout hospedado em MXN/es-419 com idempotência e sem cartão no servidor',async()=>{
 provider=async(url,o)=>{assert.equal(url,'https://api.stripe.com/v1/checkout/sessions');assert.equal(o.headers.Authorization,'Bearer sk_test_fake');const b=new URLSearchParams(o.body);assert.equal(b.get('locale'),'es-419');assert.equal(b.get('line_items[0][price_data][unit_amount]'),'10000');assert.equal(b.get('line_items[0][price_data][currency]'),'mxn');assert.equal(b.get('payment_method_types[0]'),'card');assert.equal(b.get('client_reference_id'),o.headers['Idempotency-Key']);assert.ok(!o.body.includes(body().document));return Response.json({id:'cs_test_1',url:'https://checkout.stripe.com/c/pay/test'})};
 const d=await p.create(body({document:''}),'stripe');assert.equal(d.status,'pending');assert.equal(d.paymentMethod,'card');
});
test('Stripe recusa redirecionamento para host inesperado',async()=>{
 provider=async()=>Response.json({id:'cs_test_1',url:'https://evil.example'});await assert.rejects(p.create(body(),'stripe'),e=>e.uncertain);
});
test('token adulterado e expirado não permite consultar pedido',()=>{
 const t=p.sign({scope:'payment_status',id:'test',exp:Date.now()+10000});assert.equal(p.verify(t).id,'test');assert.throws(()=>p.verify(t+'X'));assert.throws(()=>p.verify(p.sign({scope:'payment_status',id:'test',exp:1})));
});
test('SPEI confirma somente cashin confirmado com ID, moeda e valor corretos',async()=>{
 const order={id:'mx_1',provider:'xpag',provider_id:'pr_spei',amount_cents:10000,status:'pending'};rows.set(order.id,order);
 for(const override of [{currency:'BRL'},{amount:1},{transaction_id:'other'},{type:'cashout'}]){provider=async()=>Response.json({type:'cashin',transaction_id:'pr_spei',currency:'MXN',amount:100,status:'confirmed',...override});await assert.rejects(p.reconcile(order))}
 provider=async()=>Response.json({type:'cashin',transaction_id:'pr_spei',currency:'MXN',amount:100,status:'pending'});assert.equal((await p.reconcile(order)).status,'pending');
 provider=async()=>Response.json({type:'cashin',transaction_id:'pr_spei',currency:'MXN',amount:100,status:'confirmed'});assert.equal((await p.reconcile(order)).status,'approved');assert.ok(rows.get(order.id).paid_at);
});
test('Stripe exige sessão completa e paga e confere pedido/valor/moeda',async()=>{
 const order={id:'mx_card',provider:'stripe',provider_id:'cs_1',amount_cents:20000,status:'pending'};rows.set(order.id,order);
 const good={id:'cs_1',client_reference_id:'mx_card',currency:'mxn',amount_total:20000,status:'complete',payment_status:'paid'};
 for(const patch of [{currency:'brl'},{amount_total:100},{client_reference_id:'other'}]){provider=async()=>Response.json({...good,...patch});await assert.rejects(p.reconcile(order))}
 provider=async()=>Response.json({...good,payment_status:'unpaid'});assert.equal((await p.reconcile(order)).status,'pending');
 provider=async()=>Response.json(good);assert.equal((await p.reconcile(order)).status,'approved');
});
test('webhook XPag falsificado não aprova: consulta autenticada prevalece',async()=>{
 rows.set('mx_1',{id:'mx_1',provider:'xpag',provider_id:'pr_spei',amount_cents:10000,status:'pending'});
 provider=async()=>Response.json({type:'cashin',transaction_id:'pr_spei',currency:'MXN',amount:100,status:'pending'});
 const r=await call(require('../api/webhook-xpag'),{type:'cashin',currency:'MXN',transaction_id:'pr_spei',status:'confirmed'});assert.equal(r.code,200);assert.equal(rows.get('mx_1').status,'pending');
});
async function stripeWebhook(signature,raw){let code,data;const req=Readable.from([Buffer.from(raw)]);req.method='POST';req.headers={'stripe-signature':signature};await require('../api/webhook-stripe')(req,{setHeader(){},status(n){code=n;return this},json(d){data=d}});return {code,data}}
test('webhook Stripe valida assinatura e tolerância de tempo antes de consultar',async()=>{
 const raw=JSON.stringify({type:'unhandled'}),now=Math.floor(Date.now()/1000),sign=t=>createHmac('sha256','whsec_test_fake').update(t+'.'+raw).digest('hex');
 assert.equal((await stripeWebhook('t='+now+',v1='+sign(now),raw)).code,200);
 assert.equal((await stripeWebhook('t='+now+',v1='+sign(now),raw+' ')).code,400);
 assert.equal((await stripeWebhook('t=1,v1='+sign(1),raw)).code,400);assert.equal(calls.length,0);
});
test('webhook Stripe válido confirma via API e aceita repetição sem novo pedido',async()=>{
 rows.set('mx_card',{id:'mx_card',provider:'stripe',provider_id:'cs_1',amount_cents:10000,status:'pending'});
 provider=async()=>Response.json({id:'cs_1',client_reference_id:'mx_card',currency:'mxn',amount_total:10000,status:'complete',payment_status:'paid'});
 const raw=JSON.stringify({type:'checkout.session.completed',data:{object:{id:'cs_1',metadata:{order_id:'mx_card'}}}}),time=Math.floor(Date.now()/1000),sig=createHmac('sha256','whsec_test_fake').update(time+'.'+raw).digest('hex');
 for(let i=0;i<2;i++)assert.equal((await stripeWebhook('t='+time+',v1='+sig,raw)).code,200);
 assert.equal(rows.size,1);assert.equal(rows.get('mx_card').status,'approved');
});
test('API de status exige token e consulta servidor; rotas antigas não cobram',async()=>{
 assert.equal((await call(require('../api/status'),{statusToken:'forged'})).code,403);
 assert.equal((await call(require('../api/criar-pix'),body())).code,410);
});
test('HTML tem três métodos, preços em MXN, sem captura de cartão ou CPF e scripts válidos',()=>{
 const html=fs.readFileSync('index.html','utf8');
 for(const m of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g))new vm.Script(m[1]);
 for(const id of ['methPix','methOxxo','methCard','speiBank','speiBeneficiary','oxxoBarcode'])assert.ok(html.includes('id="'+id+'"'));
 for(const old of ['id="cardNumber"','id="cardCvv"','BuyerDocument','viacep.com.br','afterPix','BRL 14.90'])assert.ok(!html.includes(old),old);
 for(const price of ['MXN 150.00','MXN 75.00','MXN 45.00','MXN 105.00','MXN 300.00'])assert.ok(html.includes(price),price);
 const prices=vm.runInNewContext(html.match(/const PRICES = (\{[^;]+\});/)[1].replace(/^/,'(')+')');assert.equal(prices.base-prices.discount,100);assert.equal(prices.upsellFamiliar,200);
});
