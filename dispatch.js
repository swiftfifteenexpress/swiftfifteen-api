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
    const kwikpikRes = await fetch('https://api.kwikpik.io/v1/shipping/create', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.KWIKPIK_API_KEY,
      },
      body: JSON.stringify({
        pickup: {
          address: pickup_address,
          city: pickup_city || 'Lagos',
          contact_name: sender_name,
          contact_phone: sender_phone,
          scheduled_time: `${pickup_date} ${pickup_time || '10:00'}`,
          note: `Swift-Fifteen Express order ${order_id}`
        },
        dropoff: {
          address: delivery_address,
          contact_name: recipient_name,
          contact_phone: recipient_phone,
          note: package_description + (special_handling ? ` | Handling: ${special_handling}` : '')
        },
        package: {
          description: package_description,
          weight: package_weight || 'small',
        },
        metadata: {
          swift_order_id: order_id,
          platform: 'swiftfifteenexpress.com'
        }
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

    // Extract tracking info from Kwikpik response
    // Adjust field names below if Kwikpik uses different keys
    const trackingId    = data?.data?.tracking_id   || data?.tracking_id   || null;
    const trackingUrl   = data?.data?.tracking_url  || data?.tracking_url  || null;
    const kwikpikOrderId = data?.data?.order_id     || data?.order_id      || null;
    const riderName     = data?.data?.rider?.name   || null;
    const riderPhone    = data?.data?.rider?.phone  || null;

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
