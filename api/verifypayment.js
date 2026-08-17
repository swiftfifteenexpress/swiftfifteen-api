// ============================================================
// Swift-Fifteen Express — Paystack Verify + Shipbubble Dispatch
// Route: POST /api/verify-payment
// Docs: https://api.shipbubble.com/v1
// Flow: verify payment → geocode → validate addresses →
//       update request token → fetch_rates → create shipment
// ============================================================

function formatPhone(phone) {
  if (!phone) return '+2348029234994';
  const d = phone.toString().replace(/\D/g, '');
  if (d.startsWith('234')) return '+' + d;
  if (d.startsWith('0'))   return '+234' + d.slice(1);
  if (d.length === 10)     return '+234' + d;
  return '+' + d;
}

function cleanName(name) {
  // Remove numbers/symbols, ensure 2 words minimum (Shipbubble requirement)
  const clean = (name || '').replace(/[^a-zA-Z\s]/g, '').trim();
  const words = clean.split(' ').filter(Boolean);
  if (words.length >= 2) return clean;
  if (words.length === 1) return words[0] + ' User';
  return 'Swift User';
}

function weightToKg(w) {
  if (!w) return 1;
  if (w.includes('20kg+')) return 20;
  if (w.includes('5–20'))  return 8;
  if (w.includes('1–5'))   return 3;
  return 0.5;
}

async function geocode(address, gmKey) {
  const query = encodeURIComponent(address + ', Nigeria');
  const url   = `https://maps.googleapis.com/maps/api/geocode/json?address=${query}&key=${gmKey}&region=ng&components=country:NG`;
  const res   = await fetch(url);
  const data  = await res.json();
  if (data.status !== 'OK' || !data.results?.length) {
    throw new Error(`Geocoding failed for "${address}" — ${data.status}`);
  }
  const loc = data.results[0].geometry.location;
  return { lat: loc.lat, lng: loc.lng };
}

async function validateAddress(address, name, phone, email, sbKey, coords) {
  const payload = {
    name:      cleanName(name),
    email:     email || 'orders@swiftfifteenexpress.com',
    phone:     formatPhone(phone),
    address:   address,
    latitude:  coords.lat,
    longitude: coords.lng
  };
  console.log(`Validating "${address}" as "${payload.name}"`);
  const res  = await fetch('https://api.shipbubble.com/v1/shipping/address/validate', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${sbKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const raw  = await res.text();
  console.log(`Validate (${res.status}):`, raw);
  const data = JSON.parse(raw);
  if (data.status !== 'success' || !data.data?.address_code) {
    throw new Error(`Address validation failed: ${data.message || JSON.stringify(data.errors)}`);
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

  if (!reference) {
    return res.status(400).json({ success: false, error: 'Payment reference required' });
  }

  const PS_KEY = process.env.PAYSTACK_SECRET_KEY;
  const SB_KEY = process.env.SHIPBUBBLE_API_KEY;
  const GM_KEY = process.env.GOOGLE_MAPS_API_KEY;

  if (!PS_KEY) return res.status(500).json({ success: false, error: 'Paystack key missing' });

  try {
    // ── Step 1: Verify Paystack ───────────────────────────
    const psRes  = await fetch(
      `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
      { headers: { 'Authorization': `Bearer ${PS_KEY}` } }
    );
    const psData = await psRes.json();
    console.log('Paystack status:', psData?.data?.status, '₦' + (psData?.data?.amount / 100));

    if (!psData.status || psData.data?.status !== 'success') {
      return res.status(200).json({
        success: false, payment_verified: false,
        message: 'Payment not confirmed by Paystack',
        paystack_status: psData.data?.status || 'unknown'
      });
    }

    const paidNGN = psData.data.amount / 100;
    console.log(`Payment verified ✓ — ₦${paidNGN}`);

    // ── Step 2: Guard checks ──────────────────────────────
    if (!order_data?.pickup_address || !order_data?.delivery_address) {
      return res.status(200).json({
        success: true, payment_verified: true, paid_amount_ngn: paidNGN,
        dispatch_status: 'failed',
        message: 'Payment verified but order addresses missing'
      });
    }

    if (!SB_KEY || !GM_KEY) {
      return res.status(200).json({
        success: true, payment_verified: true, paid_amount_ngn: paidNGN,
        dispatch_status: 'failed',
        message: 'Payment verified but dispatch API keys missing'
      });
    }

    // ── Step 3: Geocode addresses ─────────────────────────
    // Qualify with city/state so geocoding doesn't guess wrong when the same
    // street name exists in multiple states (now that pickup isn't Lagos-only)
    const pickupFullAddress   = [order_data.pickup_address, order_data.pickup_city, order_data.pickup_state].filter(Boolean).join(', ');
    const deliveryFullAddress = [order_data.delivery_address, order_data.delivery_city, order_data.delivery_state].filter(Boolean).join(', ');

    console.log('Geocoding...');
    const [pickupCoords, deliveryCoords] = await Promise.all([
      geocode(pickupFullAddress, GM_KEY),
      geocode(deliveryFullAddress, GM_KEY)
    ]);

    // ── Step 4: Validate addresses ────────────────────────
    console.log('Validating addresses...');
    const [senderCode, receiverCode] = await Promise.all([
      validateAddress(
        pickupFullAddress,
        order_data.sender_name || 'Swift Fifteen',
        order_data.sender_phone,
        order_data.sender_email || 'orders@swiftfifteenexpress.com',
        SB_KEY, pickupCoords
      ),
      validateAddress(
        deliveryFullAddress,
        order_data.recipient_name || 'Delivery Recipient',
        order_data.recipient_phone || order_data.sender_phone,
        order_data.sender_email || 'recipient@example.com',
        SB_KEY, deliveryCoords
      )
    ]);

    console.log('Codes — sender:', senderCode, 'receiver:', receiverCode);

    // ── Step 5: Fetch rates ───────────────────────────────
    const today  = order_data.pickup_date || new Date().toISOString().split('T')[0];
    const weight = weightToKg(order_data.package_weight);
    const value  = parseFloat(order_data.declared_value) || 5000;

    const ratesPayload = {
      sender_address_code:   senderCode,
      reciever_address_code: receiverCode,   // Shipbubble typo — must match exactly
      pickup_date:           today,
      category_id:           74794423,       // Fashion wears (confirmed from account)
      package_items: [{
        name:        order_data.package_description || 'Package',
        description: order_data.package_description || 'Delivery package',
        unit_weight: weight,
        unit_amount: value,
        quantity:    1
      }],
      package_dimension: { length: 20, width: 15, height: 10 }
    };

    console.log('Fetching rates...');

    const ratesRes  = await fetch('https://api.shipbubble.com/v1/shipping/fetch_rates', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(ratesPayload)
    });

    const ratesRaw  = await ratesRes.text();
    console.log('Rates status:', ratesRes.status, '| Response:', ratesRaw);

    const ratesData = JSON.parse(ratesRaw);

    if (ratesData.status !== 'success' || !ratesData.data?.couriers?.length) {
      return res.status(200).json({
        success: true, payment_verified: true, paid_amount_ngn: paidNGN,
        dispatch_status: 'failed',
        message: 'Payment verified ✓ but no couriers available — dispatch manually',
        debug: ratesData
      });
    }

    const requestToken = ratesData.data.request_token;
    // Prefer fastest courier for same-day service
    const courier      = ratesData.data.fastest_courier
      || ratesData.data.cheapest_courier
      || ratesData.data.couriers[0];

    console.log('Selected courier:', courier?.courier_name, '₦' + courier?.total);

    // ── Step 6: Update request token with real names/phones ──
    // This ensures waybill shows actual sender/recipient details
    const updatePayload = {
      request_token:  requestToken,
      sender_name:    cleanName(order_data.sender_name || 'Swift Fifteen'),
      sender_phone:   formatPhone(order_data.sender_phone),
      reciever_name:  cleanName(order_data.recipient_name || 'Delivery Recipient'),
      reciever_phone: formatPhone(order_data.recipient_phone || order_data.sender_phone)
    };

    console.log('Updating request token with real details...');

    await fetch('https://api.shipbubble.com/v1/shipping/fetch_rates/request_token', {
      method: 'PATCH',
      headers: { 'Authorization': `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(updatePayload)
    });

    // ── Step 7: Create shipment (dispatch rider) ──────────
    const shipPayload = {
      request_token: requestToken,
      service_code:  courier.service_code,
      courier_id:    courier.courier_id,
      is_cod_label:  false
    };

    console.log('Creating shipment:', JSON.stringify(shipPayload));

    const shipRes  = await fetch('https://api.shipbubble.com/v1/shipping/labels', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(shipPayload)
    });

    const shipRaw  = await shipRes.text();
    console.log('Shipment status:', shipRes.status, '| Response:', shipRaw);

    const shipData = JSON.parse(shipRaw);

    if (shipData.status !== 'success') {
      return res.status(200).json({
        success: true, payment_verified: true, paid_amount_ngn: paidNGN,
        dispatch_status: 'failed', dispatch_error: shipData,
        message: 'Payment verified ✓ but dispatch failed — dispatch manually'
      });
    }

    const orderId     = shipData.data?.order_id    || null;
    const trackingUrl = shipData.data?.tracking_url || null;
    const courierName = shipData.data?.courier?.name || courier?.courier_name || null;

    console.log('✓ Dispatch success! Order:', orderId, '| Tracking:', trackingUrl);

    return res.status(200).json({
      success:          true,
      payment_verified: true,
      paid_amount_ngn:  paidNGN,
      dispatch_status:  'success',
      order_id:         orderId,
      tracking_url:     trackingUrl,
      courier_name:     courierName,
      pickup_eta:       courier?.pickup_eta   || null,
      delivery_eta:     courier?.delivery_eta || null,
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
