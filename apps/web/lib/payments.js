'use client';

import { api } from '@/lib/api';

/**
 * Pay one platform invoice.
 *
 * Razorpay: open its Checkout for the order billing raised, then hand the
 * signed result back to billing, which verifies it with the secret we never
 * ship to the browser. Test mode (local only): billing settles it directly.
 *
 * Resolves true once the invoice is paid, false if the payer closed Checkout.
 */
let checkoutScript = null;

function loadCheckout() {
  if (typeof window === 'undefined') return Promise.reject(new Error('Checkout needs a browser.'));
  if (window.Razorpay) return Promise.resolve();
  checkoutScript ??= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://checkout.razorpay.com/v1/checkout.js';
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => {
      checkoutScript = null;
      reject(new Error('Could not load the payment window. Check your connection and try again.'));
    };
    document.head.appendChild(script);
  });
  return checkoutScript;
}

export async function payInvoice(invoiceId, { confirmTest } = {}) {
  const { data: checkout } = await api.post(`/subscriptions/current/invoices/${invoiceId}/checkout`, {});

  if (checkout.provider === 'test') {
    if (confirmTest && !(await confirmTest(checkout.invoice))) return false;
    await api.post(`/subscriptions/current/invoices/${invoiceId}/test-pay`, {});
    return true;
  }

  await loadCheckout();
  return new Promise((resolve, reject) => {
    const razorpay = new window.Razorpay({
      key: checkout.key_id,
      order_id: checkout.order_id,
      amount: checkout.amount,
      currency: checkout.currency,
      name: checkout.name,
      description: checkout.description,
      prefill: checkout.prefill,
      theme: { color: '#4f46e5' },
      handler: async (result) => {
        try {
          await api.post(`/subscriptions/current/invoices/${invoiceId}/verify`, {
            razorpay_order_id: result.razorpay_order_id,
            razorpay_payment_id: result.razorpay_payment_id,
            razorpay_signature: result.razorpay_signature,
          });
          resolve(true);
        } catch (error) {
          reject(error);
        }
      },
      modal: { ondismiss: () => resolve(false) },
    });
    razorpay.on('payment.failed', (response) => {
      reject(new Error(response?.error?.description ?? 'The payment failed.'));
    });
    razorpay.open();
  });
}
