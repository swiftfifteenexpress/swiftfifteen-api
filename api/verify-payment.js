// ============================================================
// Swift-Fifteen Express — Paystack Payment Verification
// + Kwikpik Auto-Dispatch after confirmed payment
// Route: POST /api/verify-payment
// ============================================================

async function geocode(address) {
  const query = encodeURIComponent(address + ', Nigeria');
  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${query}&key=${process.env.GOOGLE_MAPS_API_KEY}&region=ng&components=country:NG`;
  const res  = await fetch(url);
  const data = await res.json();
  if (data.status !== 'OK' || !data.results?.length) {
    throw new Error(`Could not geocode: "${address}"`);
  }
  const loc = data.results[0].geometry.location;
  return { latitude: loc.lat, longitude: loc.lng, address: address };
}

function weightToKg(w) {
  if (!w) return 1;
  if (w.includes('20kg+'))  return 25;
  if (w.includes('5–20'))   return 10;
  if (w.includes('1–5'))    return 3;
  return 1;
}

export default async function handler(req, res) {

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  const { reference, order_data } = req.body;

  if (!reference) {
    return res.status(400).json({ success: false, error: 'Payment reference is required' });
  }

  if (!process.env.PAYSTACK_SECRET_KEY) {
    return res.status(500).json({ success: false, error: 'Paystack secret key not configured' });
  }

  try {
    // ── Step 1: Verify payment with Paystack ──────────────
    console.log('Verifying Paystack payment:', reference);

    const paystackRes = await fetch(
      `https://api.paystack.co/transaction/verify/${reference}`,
      {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    const paystackData = await paystackRes.json();
    console.log('Paystack verify response:', JSON.stringify(paystackData));

    // Check payment status
    if (!paystackData.status || paystackData.data?.status !== 'success') {
      return res.status(200).json({
        success: false,
        payment_verified: false,
        message: 'Payment not confirmed by Paystack',
        paystack_status: paystackData.data?.status || 'unknown'
      });
    }

    // Verify amount matches (Paystack returns amount in kobo)
    const paidAmountKobo    = paystackData.data.amount;
    const expectedAmountNGN = order_data?.amount_ngn || 0;
    const expectedKobo      = expectedAmountNGN * 100;

    // Allow ±100 kobo tolerance for rounding
    if (Math.abs(paidAmountKobo - expectedKobo) > 100) {
      console.warn(`Amount mismatch: paid ${paidAmountKobo} kobo, expected ${expectedKobo} kobo`);
      // Still proceed — log the mismatch but don't block the order
    }

    console.log(`Payment verified ✓ — ₦${paidAmountKobo / 100} paid by ${paystackData.data.customer?.email}`);

    // ── Step 2: Dispatch to Kwikpik ───────────────────────
    if (!order_data) {
      return res.status(200).json({
        success: true,
        payment_verified: true,
        dispatch_status: 'skipped',
        message: 'Payment verified but no order data provided'
      });
    }

    console.log('Geocoding addresses for dispatch...');
    const pickupFull = order_data.pickup_address
      + (order_data.pickup_city ? ', ' + order_data.pickup_city : ', Lagos');

    const [pickupCoords, deliveryCoords] = await Promise.all([
      geocode(pickupFull),
      geocode(order_data.delivery_address)
    ]);

    const kwikpikPayload = {
      vehicleType: 'motorcycle',
      pickupLocation: {
        latitude:  pickupCoords.latitude,
        longitude: pickupCoords.longitude,
        address:   order_data.pickup_address
      },
      deliveryLocation: {
        latitude:  deliveryCoords.latitude,
        longitude: deliveryCoords.longitude,
        address:   order_data.delivery_address
      },
      senderName:           order_data.sender_name,
      senderEmail:          order_data.sender_email || 'orders@swiftfifteenexpress.com',
      senderPhoneNumber:    order_data.sender_phone,
      recipientName:        order_data.recipient_name,
      recipientPhoneNumber: order_data.recipient_phone,
      description:          order_data.package_description || 'Package delivery',
      itemCategory:         'general',
      itemValue:            parseFloat(order_data.declared_value) || 0,
      itemWeight:           weightToKg(order_data.package_weight),
      itemName:             order_data.package_description || 'Package',
      insured:              false,
      itemQuantity:         1
    };

    console.log('Dispatching to Kwikpik...');

    const kwikpikRes = await fetch('https://api.kwikpik.io/partners/requests/initiate', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key':    process.env.KWIKPIK_API_KEY,
        'Accept':       'application/json',
      },
      body: JSON.stringify(kwikpikPayload)
    });

    const kwikpikRaw  = await kwikpikRes.text();
    console.log('Kwikpik dispatch status:', kwikpikRes.status);
    console.log('Kwikpik dispatch response:', kwikpikRaw);

    let kwikpikData;
    try { kwikpikData = JSON.parse(kwikpikRaw); }
    catch(e) {
      return res.status(200).json({
        success:           true,
        payment_verified:  true,
        dispatch_status:   'failed',
        dispatch_error:    kwikpikRaw,
        message:           'Payment verified ✓ but Kwikpik dispatch failed — dispatch manually'
      });
    }

    if (!kwikpikRes.ok) {
      return res.status(200).json({
        success:           true,
        payment_verified:  true,
        dispatch_status:   'failed',
        dispatch_error:    kwikpikData,
        message:           'Payment verified ✓ but Kwikpik dispatch failed — dispatch manually'
      });
    }

    const kwikpikId   = kwikpikData?.result?.id || kwikpikData?.id || null;
    const trackingUrl = kwikpikId
      ? `https://kwikpik.io/track/${kwikpikId}`
      : null;

    console.log('Dispatch successful. Kwikpik ID:', kwikpikId);

    return res.status(200).json({
      success:           true,
      payment_verified:  true,
      paid_amount_ngn:   paidAmountKobo / 100,
      dispatch_status:   'success',
      kwikpik_id:        kwikpikId,
      tracking_url:      trackingUrl,
      message:           'Payment verified and rider dispatched successfully'
    });

  } catch (err) {
    console.error('verify-payment error:', err.message);
    return res.status(200).json({
      success:          false,
      payment_verified: false,
      error:            err.message,
      message:          'Verification error — check Vercel logs'
    });
  }
}
