(function () {
  // The standard base code is inline in index.html so Meta Pixel Helper detects it.
  // This file only contains the checkout event logic.
  const sent = new Set();
  window.trackInitiateCheckout = function (total, eventId) {
    try {
      const id = eventId || ('checkout_' + Date.now());
      if (sent.has(id)) return;
      window.fbq('track', 'InitiateCheckout', {
        value: Number(total) || 0, currency: 'MXN'
      }, {eventID: id});
      sent.add(id);
    } catch (_) { /* Pixel must not interrupt checkout. */ }
  };
  window.trackPurchase = function (data) {
    try {
      if(data.paymentStatus !== 'approved') return;
      const id = data.eventId;
      if (!id || sent.has(id)) return;
      try { if (sessionStorage.getItem('meta:' + id)) return; } catch (_) {}
      window.fbq('track', 'Purchase', {
        value: Number(data.total) || 0, currency: 'MXN',
        payment_method: data.paymentMethod || 'unknown',
        payment_status: data.paymentStatus || 'pending'
      }, {eventID: id});
      sent.add(id);
      try { sessionStorage.setItem('meta:' + id, '1'); } catch (_) {}
    } catch (_) { /* Pixel must not interrupt checkout. */ }
  };
  // Compatibility name for any cached page still calling the old function.
  window.trackPixPurchase = function (data) {
    window.trackPurchase({eventId:data.metaEventId,total:data.total,paymentMethod:'pix',paymentStatus:'pending'});
  };
})();
