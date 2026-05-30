// ============================================================
// Swift-Fifteen Express — Kwikpik Auto-Dispatch Function
// Deployed on Vercel — keeps your API key hidden from the browser
// Route: POST /api/dispatch
// Called automatically after customer submits & confirms order
// ============================================================

export default async function handler(req, res) {

  res.setHeader('Access-Control-Allow-Origin', 'https://swiftfifteenexpress.com');
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
    // Sender / pickup
    sender_name,
    sender_phone,
    pickup_address,
    pickup_city,
    pickup_date,
    pickup_time,
    // Recipient / delivery
    recipient_name,
    recipient_phone,
    delivery_address,
    // Package
    package_description,
    package_weight,
    special_handling,
  } = req.body;

  // Validate required fields
  if (!pickup_address || !delivery_address || !recipient_phone || !sender_phone) {
    return res.status(400).json({
      success: false,
      error: 'Missing required delivery fields'
    });
  }

  try {
    // Book delivery on Kwikpik
    const kwikpikRes = await fetch('https://api.kwikpik.io/requests/initiate', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.KWIKPIK_API_KEY,
      },
      body: JSON.stringify({
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
      })
    });

    const data = await kwikpikRes.json();

    if (!kwikpikRes.ok) {
      console.error('Kwikpik dispatch failed:', data);
      return res.status(200).json({
        success: false,
        kwikpik_error: data,
        fallback_required: true,
        message: 'Auto-dispatch failed. Manual dispatch required on Kwikpik dashboard.'
      });
    }

    // Log full response for debugging during testing
    console.log('Kwikpik dispatch response:', JSON.stringify(data));

    // Extract tracking info — covers all common Kwikpik response shapes
    const trackingId     = data?.data?.tracking_id
      || data?.data?.trackingId
      || data?.tracking_id
      || data?.trackingId
      || null;

    const trackingUrl    = data?.data?.tracking_url
      || data?.data?.trackingUrl
      || data?.data?.tracker_url
      || data?.tracking_url
      || data?.trackingUrl
      || null;

    const kwikpikOrderId = data?.data?.order_id
      || data?.data?.id
      || data?.data?.request_id
      || data?.order_id
      || data?.id
      || null;

    const riderName  = data?.data?.rider?.name  || data?.data?.courier?.name  || null;
    const riderPhone = data?.data?.rider?.phone || data?.data?.courier?.phone || null;

    return res.status(200).json({
      success: true,
      tracking_id:    trackingId,
      tracking_url:   trackingUrl,
      kwikpik_order:  kwikpikOrderId,
      rider_name:     riderName,
      rider_phone:    riderPhone,
      message:        'Rider dispatched successfully'
    });

  } catch (err) {
    console.error('Dispatch function error:', err);
    return res.status(200).json({
      success: false,
      fallback_required: true,
      message: 'Dispatch error. Please dispatch manually on Kwikpik dashboard.',
      error: err.message
    });
  }
          }
