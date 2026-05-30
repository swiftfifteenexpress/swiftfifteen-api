// ============================================================
// Swift-Fifteen Express — Kwikpik Auto-Dispatch Function
// Route: POST /api/dispatch
// ============================================================

export default async function handler(req, res) {

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const {
    order_id,
    sender_name,
    sender_phone,
    pickup_address,
    pickup_city,
    pickup_date,
    pickup_time,
    recipient_name,
    recipient_phone,
    delivery_address,
    package_description,
    package_weight,
    special_handling,
  } = req.body;

  if (!pickup_address || !delivery_address || !recipient_phone || !sender_phone) {
    return res.status(400).json({
      success: false,
      error: 'Missing required delivery fields'
    });
  }

  if (!process.env.KWIKPIK_API_KEY) {
    console.error('KWIKPIK_API_KEY environment variable is missing');
    return res.status(200).json({
      success: false,
      fallback_required: true,
      message: 'API key not configured — dispatch manually on Kwikpik dashboard'
    });
  }

  try {
    const payload = {
      pickup_address: pickup_address,
      pickup_city: pickup_city || 'Lagos',
      pickup_contact_name: sender_name,
      pickup_contact_phone: sender_phone,
      pickup_date: pickup_date,
      pickup_time: pickup_time || '10:00',
      delivery_address: delivery_address,
      delivery_contact_name: recipient_name,
      delivery_contact_phone: recipient_phone,
      package_description: package_description,
      package_weight: package_weight || 'small',
      special_handling: special_handling || '',
      note: `Swift-Fifteen Express | Order ${order_id}`,
    };

    console.log('Calling Kwikpik dispatch with payload:', JSON.stringify(payload));

    const kwikpikRes = await fetch('https://api.kwikpik.io/requests/initiate', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.KWIKPIK_API_KEY,
      },
      body: JSON.stringify(payload)
    });

    const rawText = await kwikpikRes.text();
    console.log('Kwikpik dispatch status:', kwikpikRes.status);
    console.log('Kwikpik dispatch response:', rawText);

    let data;
    try {
      data = JSON.parse(rawText);
    } catch(e) {
      return res.status(200).json({
        success: false,
        fallback_required: true,
        message: 'Could not parse Kwikpik dispatch response',
        raw: rawText
      });
    }

    if (!kwikpikRes.ok) {
      return res.status(200).json({
        success: false,
        kwikpik_error: data,
        fallback_required: true,
        message: 'Kwikpik dispatch failed — dispatch manually on dashboard'
      });
    }

    // Extract tracking info — covers all common response shapes
    const trackingId   = data?.data?.tracking_id   || data?.data?.trackingId   || data?.tracking_id   || data?.trackingId   || null;
    const trackingUrl  = data?.data?.tracking_url  || data?.data?.trackingUrl  || data?.data?.tracker_url || data?.tracking_url  || data?.trackingUrl  || null;
    const kwikpikOrder = data?.data?.order_id      || data?.data?.id           || data?.data?.request_id  || data?.order_id      || data?.id            || null;
    const riderName    = data?.data?.rider?.name   || data?.data?.courier?.name  || null;
    const riderPhone   = data?.data?.rider?.phone  || data?.data?.courier?.phone || null;

    return res.status(200).json({
      success: true,
      tracking_id:   trackingId,
      tracking_url:  trackingUrl,
      kwikpik_order: kwikpikOrder,
      rider_name:    riderName,
      rider_phone:   riderPhone,
      message:       'Rider dispatched successfully'
    });

  } catch (err) {
    console.error('Dispatch function error:', err.message);
    return res.status(200).json({
      success: false,
      fallback_required: true,
      message: 'Dispatch error — dispatch manually on Kwikpik dashboard',
      error: err.message
    });
  }
    }
