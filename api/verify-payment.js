// ============================================================
// Swift-Fifteen Express — Paystack Verify + Shipbubble Dispatch
// Route: POST /api/verify-payment
// ============================================================

function formatPhone(phone) {
  if (!phone) return '';
  const digits = phone.toString().replace(/\D/g, '');
  if (digits.startsWith('234')) return '+' + digits;
  if (digits.startsWith('0'))   return '+234' + digits.slice(1);
  if (digits.length === 10)     return '+234' + digits;
  return '+' + digits;
}

function weightToKg(w) {
  if (!w) return 1;
  if (w.includes('20kg+')) return 20;
  if (w.includes('5–20'))  return 8;
  if (w.includes('1–5'))   return 3;
  return 0.5;
}

export default async function handler(req, res) {

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  const { reference, order_data } = req.body;

  console.log('=== verify-payment called ===');
  console.log('Reference:', reference);
  console.log('Order data keys:', order_data ? Object.keys(order_data).join(', ') : 'MISSING');

  if (!reference) {
    return res.status(400).json({ success: false, error: 'Payment reference is required' });
  }

  if (!process.env.PAYSTACK_SECRET_KEY) {
    console.error('PAYSTACK_SECRET_KEY missing');
    return res.status(500).json({ success: false, error: 'Paystack secret key not configured' });
  }

  if (!process.env.SHIPBUBBLE_API_KEY) {
    console.error('SHIPBUBBLE_API_KEY missing');
  }

  try {
    // ── Step 1: Verify with Paystack ─────────────────────
    console.log('Verifying Paystack payment...');

    const paystackRes = await fetch(
      `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
      {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    const paystackData = await paystackRes.json();
    console.log('Paystack status:', paystackData?.data?.status);
    console.log('Paystack amount (kobo):', paystackData?.data?.amount);

    if (!paystackData.status || paystackData.data?.status !== 'success') {
      return res.status(200).json({
        success: false,
        payment_verified: false,
        message: 'Payment not confirmed by Paystack',
        paystack_status: paystackData.data?.status || 'unknown'
      });
    }

    const paidAmountKobo = paystackData.data.amount;
    console.log(`Payment verified ✓ — ₦${paidAmountKobo / 100}`);

    // ── Step 2: Dispatch via Shipbubble ──────────────────
    if (!order_data || !order_data.pickup_address || !order_data.delivery_address) {
      console.error('Missing order data or addresses');
      return res.status(200).json({
        success: true,
        payment_verified: true,
        dispatch_status: 'failed',
        message: 'Payment verified but order data was missing'
      });
    }

    const weight = weightToKg(order_data.package_weight);
    const declaredValue = parseFloat(order_data.declared_value) || 1000;
    const pickupDate = order_data.pickup_date || new Date().toISOString().split('T')[0];

    // Step 2a — Fetch rates from Shipbubble
    const ratesPayload = {
      pickup_date:   pickupDate,
      category_id:   1,
      package_items: [{
        name:         order_data.package_description || 'Package',
        description:  order_data.package_description || 'Delivery package',
        unit_weight:  weight,
        unit_amount:  declaredValue,
        quantity:     1
      }],
      package_dimension: { length: 10, width: 10, height: 10 },
      sender_address: {
        name:    order_data.sender_name    || 'Sender',
        email:   order_data.sender_email   || 'orders@swiftfifteenexpress.com',
        phone:   formatPhone(order_data.sender_phone),
        address: order_data.pickup_address
      },
      receiver_address: {
        name:    order_data.recipient_name  || 'Recipient',
        email:   order_data.sender_email    || 'recipient@example.com',
        phone:   formatPhone(order_data.recipient_phone || order_data.sender_phone),
        address: order_data.delivery_address
      }
    };

    console.log('Fetching Shipbubble rates...');
    console.log('Rates payload:', JSON.stringify(ratesPayload));

    const ratesRes = await fetch('https://api.shipbubble.com/v1/shipping/fetch_rates', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.SHIPBUBBLE_API_KEY}`,
        'Content-Type':  'application/json',
        'Accept':        'application/json'
      },
      body: JSON.stringify(ratesPayload)
    });

    const ratesRaw = await ratesRes.text();
    console.log('Shipbubble rates HTTP status:', ratesRes.status);
    console.log('Shipbubble rates response:', ratesRaw);

    let ratesData;
    try { ratesData = JSON.parse(ratesRaw); }
    catch(e) {
      console.error('Non-JSON from Shipbubble rates:', ratesRaw.substring(0, 300));
      return res.status(200).json({
        success: true, payment_verified: true,
        paid_amount_ngn: paidAmountKobo / 100,
        dispatch_status: 'failed',
        message: 'Payment verified ✓ but Shipbubble rates returned non-JSON'
      });
    }

    if (ratesData.status !== 'success' || !ratesData.data?.couriers?.length) {
      console.error('No Shipbubble couriers:', JSON.stringify(ratesData));
      return res.status(200).json({
        success: true, payment_verified: true,
        paid_amount_ngn: paidAmountKobo / 100,
        dispatch_status: 'failed',
        message: 'Payment verified ✓ but no couriers available for this route'
      });
    }

    const requestToken    = ratesData.data.request_token;
    const selectedCourier = ratesData.data.cheapest_courier;

    console.log('Selected courier:', selectedCourier?.courier_name, '₦' + selectedCourier?.total);

    // Step 2b — Create shipment (dispatch rider)
    const shipmentPayload = {
      request_token: requestToken,
      courier_id:    selectedCourier.courier_id,
      service_code:  selectedCourier.service_code,
      is_cod_label:  false
    };

    console.log('Creating Shipbubble shipment...');
    console.log('Shipment payload:', JSON.stringify(shipmentPayload));

    const shipRes = await fetch('https://api.shipbubble.com/v1/shipping/labels', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.SHIPBUBBLE_API_KEY}`,
        'Content-Type':  'application/json',
        'Accept':        'application/json'
      },
      body: JSON.stringify(shipmentPayload)
    });

    const shipRaw = await shipRes.text();
    console.log('Shipbubble shipment HTTP status:', shipRes.status);
    console.log('Shipbubble shipment response:', shipRaw);

    let shipData;
    try { shipData = JSON.parse(shipRaw); }
    catch(e) {
      console.error('Non-JSON from Shipbubble shipment:', shipRaw.substring(0, 300));
      return res.status(200).json({
        success: true, payment_verified: true,
        paid_amount_ngn: paidAmountKobo / 100,
        dispatch_status: 'failed',
        message: 'Payment verified ✓ but Shipbubble shipment returned non-JSON'
      });
    }

    if (shipData.status !== 'success') {
      console.error('Shipbubble shipment failed:', JSON.stringify(shipData));
      return res.status(200).json({
        success: true, payment_verified: true,
        paid_amount_ngn: paidAmountKobo / 100,
        dispatch_status: 'failed',
        dispatch_error: shipData,
        message: 'Payment verified ✓ but dispatch failed — dispatch manually'
      });
    }

    // Success — extract tracking info
    const orderId     = shipData.data?.order_id    || null;
    const trackingUrl = shipData.data?.tracking_url || null;
    const courierName = shipData.data?.courier?.name || selectedCourier?.courier_name || null;
    const pickupEta   = selectedCourier?.pickup_eta   || null;

    console.log('Dispatch successful! Order ID:', orderId);
    console.log('Tracking URL:', trackingUrl);

    return res.status(200).json({
      success:           true,
      payment_verified:  true,
      paid_amount_ngn:   paidAmountKobo / 100,
      dispatch_status:   'success',
      order_id:          orderId,
      tracking_url:      trackingUrl,
      courier_name:      courierName,
      pickup_eta:        pickupEta,
      message:           'Payment verified and rider dispatched successfully'
    });

  } catch (err) {
    console.error('verify-payment error:', err.message);
    console.error('Stack:', err.stack);
    return res.status(200).json({
      success: false,
      payment_verified: false,
      dispatch_status: 'error',
      error: err.message,
      message: 'Server error — check Vercel logs'
    });
  }
}
