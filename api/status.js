const p=require('../lib/mexico');
module.exports=p.route(async req=>{
 const t=p.verify(p.input(req).statusToken);
 const order=await p.reconcile(await p.getOrder(t.id));
 return {...p.response(order),email:order.email,quizData:order.quiz_data};
});
