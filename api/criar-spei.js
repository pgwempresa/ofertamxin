const p=require('../lib/mexico');
module.exports=p.route(req=>p.create(p.input(req),'xpag'));
