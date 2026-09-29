const {PRICES}=require('../lib/mexico');
module.exports=(req,res)=>{res.setHeader('Cache-Control','no-store');res.status(200).json({currency:'MXN',prices:PRICES,orderBump:{preco:PRICES.extras},maxParcelas:1});};
