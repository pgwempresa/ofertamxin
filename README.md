# Tu Cuentito — México

Oferta em espanhol mexicano. Pagamentos em **MXN**: SPEI e OXXO via XPag; cartão via Stripe Checkout hospedado. Mudanças locais; nenhum deploy ou cobrança real foi realizado.

## Preços

Os valores finais informados foram preservados. Preço de comparação = preço final × 1,5, conforme solicitado. Essa relação equivale a 33,33% de desconto sobre o valor de comparação, não a 50% de desconto.

| Produto | Comparação | Final (MXN) |
|---|---:|---:|
| Livro | 150 | 100 |
| Versão para colorir | 75 | 50 |
| Entrega expressa | 45 | 30 |
| Duas histórias extras | 105 | 70 |
| Extra familiar | 300 | 200 |

Fonte dos preços cobrados: `lib/mexico.js`. Valores exibidos também estão em `index.html`. Os descontos brasileiros e a segunda oferta de desconto foram desativados. Flags de desconto enviadas pelo navegador não alteram o total calculado pelo servidor.

## Configuração

Vercel: Node 22, preset Other, sem build command. Configure as variáveis de `.env.example` no ambiente desejado, sem incluir segredos no frontend:

- `PUBLIC_SITE_URL`: origem HTTPS do site, sem caminho. Usada nos retornos da Stripe e callback XPag.
- `PAYMENT_SIGNING_SECRET`: segredo aleatório com pelo menos 32 caracteres para assinar consultas. Gere localmente; não reutilize chaves de gateway.
- `SUPABASE_URL` e `SUPABASE_SERVICE_ROLE_KEY`: armazenamento de pedidos, somente no servidor.
- `XPAG_CLIENT_ID` e `XPAG_CLIENT_SECRET`: credenciais XPag com cash-in MXN/SPEI/OXXO habilitados e permissão `balance` para consulta.
- `STRIPE_SECRET_KEY`: chave secreta da conta Stripe; comece em ambiente de teste.
- `STRIPE_WEBHOOK_SECRET`: segredo do endpoint de webhook Stripe, correspondente ao mesmo ambiente.

Execute `supabase/migrations/20260929_payment_orders.sql` no SQL editor do Supabase. A tabela usa RLS e não concede acesso a `anon`/`authenticated`. Sem persistência ou credenciais, o servidor recusa a criação de cobranças.

Configure na Stripe o endpoint `https://SEU_DOMINIO/api/webhook-stripe`, com eventos `checkout.session.completed`, `checkout.session.async_payment_succeeded` e `checkout.session.expired`. A XPag recebe `webhook_url` no corpo de cada cobrança; a documentação não pede cadastro separado no painel.

## Fluxos implementados

- `POST /api/criar-spei`: XPag `POST https://api.xpag.global/cashin`, moeda MXN e valor fixo. Retorna CLABE, banco, beneficiário e referência. A tela orienta transferência pelo valor exato e validade documentada de 24 horas.
- `POST /api/criar-oxxo`: mesma rota XPag, `method: OXXO`, `generateCheckout: false`, nome/e-mail em `payerData`. Exibe referência e código de barras HTTPS; validade documentada de 12 dias. Confirmação é assíncrona após o pagamento em loja. Faixa documentada: MXN 10–10.000; os preços atuais ficam nessa faixa.
- `POST /api/criar-cartao`: cria Stripe Checkout Session, `payment_method_types: [card]`, `locale: es-419`, moeda MXN e valores em centavos. PAN/CVV não passam pelo site nem pelo servidor da oferta. O comprador é redirecionado para `checkout.stripe.com` e retorna para confirmação.
- `POST /api/status`: exige token assinado e consulta a operadora no servidor. Só aprova com ID, valor, moeda e estado de pagamento compatíveis. A URL de retorno por si só nunca aprova um pedido.
- Webhooks: persistem a confirmação mesmo com o navegador fechado. Stripe usa assinatura HMAC do corpo bruto com tolerância de cinco minutos. A documentação pública consultada da XPag não especifica uma assinatura; seu callback somente dispara uma consulta autenticada, e o estado enviado no callback não é confiável por si só.

Uma reserva única no banco precede a chamada ao gateway. A mesma tentativa não cria uma segunda cobrança. A Stripe recebe também `Idempotency-Key`. A documentação de idempotência XPag se refere à CLABE aberta, não à cobrança dinâmica usada aqui: portanto, falhas ambíguas são marcadas como `uncertain`, bloqueando recriação automática. Nesses casos, reconcilie a transação na operadora antes de liberar nova tentativa. Uma falha de persistência posterior à criação exige essa reconciliação manual; não há retry cego de cash-in.

A XPag fornece CURP no exemplo SPEI. O formulário usa CURP da pessoa adulta, com validação de formato (não consulta governamental). OXXO e Stripe não exigem esse campo. O telefone usa México +52 e dez dígitos nacionais. Confirmar os requisitos efetivos da conta e o campo `currency` na resposta de consulta durante homologação; a integração recusa aprovar se esse campo estiver ausente.

## Rastreamento e recuperação

O Pixel continua instalado, agora em MXN. `Purchase` no navegador só dispara após confirmação autenticada, deduplicado por ID do pedido. Não há CAPI no novo fluxo; `lib/meta.js` e `lib/payment.js` pertencem à integração brasileira legada e não são chamados pelas novas rotas.

Pix/Amplo Pay foram desligados nas rotas de cobrança antigas (HTTP 410). A recuperação brasileira automática por e-mail não recebe os novos pedidos. O código legado de jobs permanece separado; migrar templates, tipos e esquema antes de ativar recuperação mexicana. Novos pedidos e informações do quiz ficam em `payment_orders`. CURP não é persistida. O livro ainda não é gerado nem entregue automaticamente por esta integração: uma futura fila de entrega deve consumir pedidos `approved` com deduplicação por `id`. Não ativar vendas contando com entrega automática antes dessa etapa.

## Validação e homologação

`npm test` cobre valores, todos os adicionais, adulteração de total, dados inválidos, persistência, concorrência, falhas ambíguas, tokens, assinatura Stripe, callbacks XPag falsificados, confirmação por valor/moeda/ID e criação de SPEI/OXXO/Stripe com operadoras simuladas. Nenhuma chamada de cobrança real faz parte dos testes.

Para homologar após configurar segredos e SQL: criar pedidos em ambiente de teste, conferir instruções e preço, completar pagamento de teste, observar webhook e estado `approved`, repetir notificações, verificar retorno/cancelamento Stripe e validar expirados. O preview estático local mostra o layout, mas não executa funções Vercel.

## Documentação oficial consultada

- [XPag — autenticação](https://xpag.global/docs/autenticacao)
- [XPag — cobranças, aba MXN SPEI/OXXO](https://xpag.global/docs/cobrancas)
- [XPag — consulta de transações](https://xpag.global/docs/status)
- [XPag — webhooks](https://xpag.global/docs/webhooks)
- [Stripe — criar Checkout Session](https://docs.stripe.com/api/checkout/sessions/create)
- [Stripe — consultar Checkout Session](https://docs.stripe.com/api/checkout/sessions/retrieve)
- [Stripe — verificação de assinatura de webhook](https://docs.stripe.com/webhooks/signature)
