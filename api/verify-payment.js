// ============================================================
// Swift-Fifteen Express — Paystack Verify + Shipbubble Dispatch
// Route: POST /api/verify-payment
// Flow: verify payment → validate addresses → fetch rates → dispatch
// ============================================================

function formatPhone(phone) {
  if (!phone) return '+2348000000000';
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

async function validateAddress(address, name, phone, email, apiKey) {
  const payload = {
    name:    name,
    email:   email || 'orders@swiftfifteenexpress.com',
    phone:   formatPhone(phone),
    address: address + (address.toLowerCase().includes('nigeria') ? '' : ', Lagos, Nigeria')
  };

  console.log(`Validating: "${address}"`);

  const res  = await fetch('https://api.shipbubble.com/v1/shipping/address/validate', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type':  'application/json',
      'Accept':        'application/json'
    },
    body: JSON.stringify(payload)
  });

  const raw  = await res.text();
  console.log(`Validate status: ${res.status}, response: ${raw}`);

  const data = JSON.parse(raw);
  if (data.status !== 'success' || !data.data?.address_code) {
    throw new Error(`Address validation failed: "${address}" — ${data.message}`);
  }
  return data.data.address_code;
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
  console.log('Has order_data:', !!order_data);

  if (!reference) {
    return res.status(400).json({ success: false, error: 'Payment reference is required' });
  }

  const SHIPBUBBLE_KEY = process.env.SHIPBUBBLE_API_KEY;
  const PAYSTACK_KEY   = process.env.PAYSTACK_SECRET_KEY;

  if (!PAYSTACK_KEY) {
    return res.status(500).json({ success: false, error: 'Paystack secret key not configured' });
  }

  try {
    // ── Step 1: Verify Paystack payment ──────────────────
    console.log('Verifying Paystack...');
    const psRes  = await fetch(
      `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
      { headers: { 'Authorization': `Bearer ${PAYSTACK_KEY}` } }
    );
    const psData = await psRes.json();
    console.log('Paystack status:', psData?.data?.status, '— Amount:', psData?.data?.amount);

    if (!psData.status || psData.data?.status !== 'success') {
      return res.status(200).json({
        success: false, payment_verified: false,
        paystack_status: psData.data?.status || 'unknown',
        message: 'Payment not confirmed by Paystack'
      });
    }

    const paidNGN = psData.data.amount / 100;
    console.log(`Payment verified ✓ — ₦${paidNGN}`);

    if (!order_data?.pickup_address || !order_data?.delivery_address) {
      return res.status(200).json({
        success: true, payment_verified: true,
        dispatch_status: 'failed',
        message: 'Payment verified but order addresses missing'
      });
    }

    if (!SHIPBUBBLE_KEY) {
      return res.status(200).json({
        success: true, payment_verified: true, paid_amount_ngn: paidNGN,
        dispatch_status: 'failed',
        message: 'Payment verified but Shipbubble API key not configured'
      });
    }

    // ── Step 2: Validate addresses ────────────────────────
    console.log('Validating addresses...');
    const [senderCode, receiverCode] = await Promise.all([
      validateAddress(
        order_data.pickup_address,
        order_data.sender_name  || 'Sender',
        order_data.sender_phone,
        order_data.sender_email || 'orders@swiftfifteenexpress.com',
        SHIPBUBBLE_KEY
      ),
      validateAddress(
        order_data.delivery_address,
        order_data.recipient_name  || 'Recipient',
        order_data.recipient_phone || order_data.sender_phone,
        order_data.sender_email    || 'recipient@example.com',
        SHIPBUBBLE_KEY
      )
    ]);

    console.log('Sender code:', senderCode, '— Receiver code:', receiverCode);

    // ── Step 3: Fetch rates ───────────────────────────────
    const weight       = weightToKg(order_data.package_weight);
    const declaredValue = parseFloat(order_data.declared_value) || 1000;
    const pickupDate   = order_data.pickup_date || new Date().toISOString().split('T')[0];

    const ratesPayload = {
      pickup_date:    pickupDate,
      category_id:    1,
      package_items: [{
        name:         order_data.package_description || 'Package',
        description:  order_data.package_description || 'Delivery',
        unit_weight:  weight,
        unit_amount:  declaredValue,
        quantity:     1
      }],
      package_dimension: { length: 10, width: 10, height: 10 },
      sender_address_code:   senderCode,
      receiver_address_code: receiverCode
    };

    console.log('Fetching rates:', JSON.stringify(ratesPayload));

    const ratesRes = await fetch('https://api.shipbubble.com/v1/shipping/fetch_rates', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${SHIPBUBBLE_KEY}`,
        'Content-Type':  'application/json',
        'Accept':        'application/json'
      },
      body: JSON.stringify(ratesPayload)
    });

    const ratesRaw  = await ratesRes.text();
    const ratesData = JSON.parse(ratesRaw);
    console.log('Rates status:', ratesRes.status);
    console.log('Couriers found:', ratesData.data?.couriers?.length || 0);

    if (ratesData.status !== 'success' || !ratesData.data?.couriers?.length) {
      return res.status(200).json({
        success: true, payment_verified: true, paid_amount_ngn: paidNGN,
        dispatch_status: 'failed',
        message: 'Payment verified ✓ but no couriers available — dispatch manually'
      });
    }

    const requestToken    = ratesData.data.request_token;
    const selectedCourier = ratesData.data.cheapest_courier;
    console.log('Selected:', selectedCourier?.courier_name, '₦' + selectedCourier?.total);

    // ── Step 4: Create shipment (dispatch rider) ──────────
    const shipPayload = {
      request_token: requestToken,
      courier_id:    selectedCourier.courier_id,
      service_code:  selectedCourier.service_code,
      is_cod_label:  false
    };

    console.log('Creating shipment:', JSON.stringify(shipPayload));

    const shipRes  = await fetch('https://api.shipbubble.com/v1/shipping/labels', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${SHIPBUBBLE_KEY}`,
        'Content-Type':  'application/json',
        'Accept':        'application/json'
      },
      body: JSON.stringify(shipPayload)
    });

    const shipRaw  = await shipRes.text();
    const shipData = JSON.parse(shipRaw);
    console.log('Shipment HTTP status:', shipRes.status);
    console.log('Shipment response:', shipRaw);

    if (shipData.status !== 'success') {
      return res.status(200).json({
        success: true, payment_verified: true, paid_amount_ngn: paidNGN,
        dispatch_status: 'failed', dispatch_error: shipData,
        message: 'Payment verified ✓ but dispatch failed — dispatch manually'
      });
    }

    const orderId     = shipData.data?.order_id    || null;
    const trackingUrl = shipData.data?.tracking_url || null;
    const courierName = shipData.data?.courier?.name || selectedCourier?.courier_name;

    console.log('Dispatch success! Order:', orderId, 'Tracking:', trackingUrl);

    return res.status(200).json({
      success:          true,
      payment_verified: true,
      paid_amount_ngn:  paidNGN,
      dispatch_status:  'success',
      order_id:         orderId,
      tracking_url:     trackingUrl,
      courier_name:     courierName,
      pickup_eta:       selectedCourier?.pickup_eta || null,
      message:          'Payment verified and rider dispatched successfully'
    });

  } catch (err) {
    console.error('verify-payment error:', err.message);
    return res.status(200).json({
      success: false, payment_verified: false,
      dispatch_status: 'error', error: err.message,
      message: 'Server error — check Vercel logs'
    });
  }
}
