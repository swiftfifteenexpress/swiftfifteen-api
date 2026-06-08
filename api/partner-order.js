// ============================================================
// Swift-Fifteen Express — Partner API Endpoint
// Route: POST /api/partner-order
// For: Marketplace and e-commerce platform integrations
// Auth: x-api-key header
// ============================================================

const MARGIN = 1.25; // 25% margin on Shipbubble cost

function formatPhone(phone) {
  if (!phone) return '+2348029234994';
  const d = phone.toString().replace(/\D/g, '');
  if (d.startsWith('234')) return '+' + d;
  if (d.startsWith('0'))   return '+234' + d.slice(1);
  if (d.length === 10)     return '+234' + d;
  return '+' + d;
}

function cleanName(name) {
  const clean = (name || '').replace(/[^a-zA-Z\s]/g, '').trim();
  const words = clean.split(' ').filter(Boolean);
  if (words.length >= 2) return clean;
  if (words.length === 1) return words[0] + ' User';
  return 'Swift User';
}

function weightToKg(w) {
  if (!w) return 1;
  if (typeof w === 'number') return w;
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
  const res  = await fetch('https://api.shipbubble.com/v1/shipping/address/validate', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${sbKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const data = await res.json();
  if (data.status !== 'success' || !data.data?.address_code) {
    throw new Error(`Address validation failed: ${data.message}`);
  }
  return data.data.address_code;
}

export default async function handler(req, res) {

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key');

  if (req.method === 'OPTIONS') return res.status(200).end();

  // ── Health check ──────────────────────────────────────────
  if (req.method === 'GET') {
    return res.status(200).json({
      status:  'active',
      service: 'Swift-Fifteen Express Partner API',
      version: 'v1.0',
      endpoints: {
        create_order: 'POST /api/partner-order',
        get_rates:    'POST /api/estimate'
      },
      docs: 'Contact swiftfifteenexpress@gmail.com for documentation'
    });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed. Use POST.' });
  }

  // ── Step 1: Authenticate partner ─────────────────────────
  const apiKey = req.headers['x-api-key'] || req.body?.api_key;

  // Partner keys stored as env vars: PARTNER_KEY_1, PARTNER_KEY_2 etc.
  const partnerKeys = {
    [process.env.PARTNER_KEY_1]: { name: process.env.PARTNER_NAME_1 || 'Partner 1', rate_type: 'standard' },
    [process.env.PARTNER_KEY_2]: { name: process.env.PARTNER_NAME_2 || 'Partner 2', rate_type: 'standard' },
    [process.env.PARTNER_KEY_3]: { name: process.env.PARTNER_NAME_3 || 'Partner 3', rate_type: 'wholesale' },
  };

  const partner = apiKey ? partnerKeys[apiKey] : null;

  if (!apiKey || !partner) {
    console.warn('Unauthorized attempt. Key prefix:', apiKey?.substring(0, 8));
    return res.status(401).json({
      success: false,
      error:   'Invalid or missing API key.',
      message: 'Contact swiftfifteenexpress@gmail.com to get your API key.'
    });
  }

  console.log(`=== partner-order: ${partner.name} ===`);

  // ── Step 2: Validate required fields ─────────────────────
  const {
    sender_name,
    sender_phone,
    sender_email,
    pickup_address,
    recipient_name,
    recipient_phone,
    delivery_address,
    package_description,
    package_weight,
    declared_value,
    pickup_date,
    partner_order_id
  } = req.body;

  const missing = [];
  if (!sender_name)      missing.push('sender_name');
  if (!sender_phone)     missing.push('sender_phone');
  if (!pickup_address)   missing.push('pickup_address');
  if (!recipient_name)   missing.push('recipient_name');
  if (!recipient_phone)  missing.push('recipient_phone');
  if (!delivery_address) missing.push('delivery_address');

  if (missing.length) {
    return res.status(400).json({
      success: false,
      error:   `Missing required fields: ${missing.join(', ')}`,
      required_fields: [
        'sender_name', 'sender_phone', 'pickup_address',
        'recipient_name', 'recipient_phone', 'delivery_address'
      ],
      optional_fields: [
        'sender_email', 'package_description', 'package_weight',
        'declared_value', 'pickup_date', 'partner_order_id'
      ]
    });
  }

  const SB_KEY = process.env.SHIPBUBBLE_API_KEY;
  const GM_KEY = process.env.GOOGLE_MAPS_API_KEY;
  const WH_URL = 'https://hook.eu1.make.com/spghqh54xphosrxo1k058pz2a2pz37op';
  const orderId = 'SFX-' + Date.now();

  if (!SB_KEY || !GM_KEY) {
    return res.status(500).json({ success: false, error: 'Server configuration error' });
  }

  try {
    // ── Step 3: Geocode ───────────────────────────────────
    console.log('Geocoding addresses...');
    const [pickupCoords, deliveryCoords] = await Promise.all([
      geocode(pickup_address, GM_KEY),
      geocode(delivery_address, GM_KEY)
    ]);

    // ── Step 4: Validate addresses ────────────────────────
    console.log('Validating addresses...');
    const [senderCode, receiverCode] = await Promise.all([
      validateAddress(
        pickup_address, sender_name, sender_phone,
        sender_email || 'orders@swiftfifteenexpress.com',
        SB_KEY, pickupCoords
      ),
      validateAddress(
        delivery_address, recipient_name, recipient_phone,
        sender_email || 'recipient@swiftfifteenexpress.com',
        SB_KEY, deliveryCoords
      )
    ]);

    console.log('Codes — sender:', senderCode, 'receiver:', receiverCode);

    // ── Step 5: Fetch rates ───────────────────────────────
    const today  = pickup_date || new Date().toISOString().split('T')[0];
    const weight = weightToKg(package_weight);
    const value  = parseFloat(declared_value) || 5000;

    const ratesPayload = {
      sender_address_code:   senderCode,
      reciever_address_code: receiverCode,
      pickup_date:           today,
      category_id:           74794423,
      package_items: [{
        name:        package_description || 'Package',
        description: package_description || 'Delivery package',
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
    const ratesData = await ratesRes.json();

    if (ratesData.status !== 'success' || !ratesData.data?.couriers?.length) {
      return res.status(200).json({
        success: false, order_id: orderId,
        error: 'No couriers available for this route at this time. Please try again shortly.'
      });
    }

    const requestToken = ratesData.data.request_token;
    const courier      = ratesData.data.fastest_courier
      || ratesData.data.cheapest_courier
      || ratesData.data.couriers[0];

    const shipbubbleCost = parseFloat(courier.total);
    const deliveryFee    = partner.rate_type === 'wholesale'
      ? shipbubbleCost
      : Math.ceil((shipbubbleCost * MARGIN) / 100) * 100;

    console.log(`Courier: ${courier.courier_name} | Cost: ₦${shipbubbleCost} | Partner fee: ₦${deliveryFee}`);

    // ── Step 6: Update request token ─────────────────────
    await fetch('https://api.shipbubble.com/v1/shipping/fetch_rates/request_token', {
      method: 'PATCH',
      headers: { 'Authorization': `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        request_token:  requestToken,
        sender_name:    cleanName(sender_name),
        sender_phone:   formatPhone(sender_phone),
        reciever_name:  cleanName(recipient_name),
        reciever_phone: formatPhone(recipient_phone)
      })
    });

    // ── Step 7: Create shipment ───────────────────────────
    console.log('Dispatching rider...');
    const shipRes  = await fetch('https://api.shipbubble.com/v1/shipping/labels', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        request_token: requestToken,
        service_code:  courier.service_code,
        courier_id:    courier.courier_id,
        is_cod_label:  false
      })
    });
    const shipData = await shipRes.json();
    console.log('Shipment response:', JSON.stringify(shipData));

    if (shipData.status !== 'success') {
      return res.status(200).json({
        success: false, order_id: orderId,
        error:   shipData.message || 'Dispatch failed',
        message: 'Please retry or contact swiftfifteenexpress@gmail.com'
      });
    }

    const sbOrderId   = shipData.data?.order_id    || null;
    const trackingUrl = shipData.data?.tracking_url || null;
    const courierName = shipData.data?.courier?.name || courier.courier_name;

    console.log(`✓ Dispatched — SB: ${sbOrderId} | Tracking: ${trackingUrl}`);

    // ── Step 8: Log to Google Sheets via Make.com ─────────
    try {
      const params = new URLSearchParams();
      Object.entries({
        Order_ID:            orderId,
        Partner_Order_ID:    partner_order_id || '',
        Partner_Name:        partner.name,
        Submitted_At:        new Date().toISOString(),
        Sender_Name:         sender_name,
        Sender_Phone:        sender_phone,
        Pickup_Address:      pickup_address,
        Recipient_Name:      recipient_name,
        Recipient_Phone:     recipient_phone,
        Delivery_Address:    delivery_address,
        Package_Description: package_description || '',
        Package_Weight:      package_weight || '',
        Declared_Value_NGN:  declared_value || '',
        Courier:             courierName,
        Shipbubble_Cost_NGN: shipbubbleCost,
        Amount_NGN:          deliveryFee,
        Payment_Method:      'Partner API — invoiced',
        Shipbubble_Order_ID: sbOrderId,
        Tracking_URL:        trackingUrl,
        Dispatch_Status:     'success',
        Status:              'Dispatched via Partner API',
        Source:              `Partner API — ${partner.name}`
      }).forEach(([k, v]) => params.append(k, String(v)));

      fetch(WH_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString()
      });
    } catch(e) {
      console.error('Webhook log error (non-blocking):', e.message);
    }

    // ── Step 9: Return success to partner ─────────────────
    return res.status(200).json({
      success:          true,
      order_id:         orderId,
      partner_order_id: partner_order_id || null,
      shipbubble_order: sbOrderId,
      tracking_url:     trackingUrl,
      courier:          courierName,
      pickup_eta:       courier.pickup_eta   || null,
      delivery_eta:     courier.delivery_eta || null,
      delivery_fee_ngn: deliveryFee,
      currency:         'NGN',
      status:           'dispatched',
      message:          `Order dispatched via ${courierName}`
    });

  } catch (err) {
    console.error('partner-order error:', err.message);
    return res.status(500).json({
      success:  false,
      order_id: orderId,
      error:    err.message,
      message:  'Server error. Please retry or contact swiftfifteenexpress@gmail.com'
    });
  }
}
