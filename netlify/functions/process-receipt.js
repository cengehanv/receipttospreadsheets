// netlify/functions/process-receipt.js
exports.handler = async (event, context) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: 'Method Not Allowed' };
  }

  try {
    const { imageData } = JSON.parse(event.body);
    const base64Image = imageData.split(',')[1];
    
    // Using OCR.Space free API
    const response = await fetch('https://api.ocr.space/parse/image', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: `base64Image=data:image/jpeg;base64,${base64Image}&language=eng&apikey=helloworld`
    });

    const result = await response.json();
    
    if (result.ParsedResults && result.ParsedResults[0].ParsedText) {
      const extractedText = result.ParsedResults[0].ParsedText;
      const parsedData = parseReceiptText(extractedText);
      
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ 
          success: true, 
          data: parsedData,
          rawText: extractedText 
        })
      };
    } else {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ 
          success: false, 
          error: 'No text found in image' 
        })
      };
    }
    
  } catch (error) {
    console.error('OCR Error:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ 
        success: false, 
        error: error.message 
      })
    };
  }
};

function parseReceiptText(text) {
  const lines = text.split('\r\n').map(line => line.trim()).filter(line => line.length > 0);
  
  const items = [];
  let total = '0.00';
  let tax = '0.00';
  
  // Find total
  for (const line of lines) {
    const totalMatch = line.match(/total.*?[\$]?(\d+\.?\d{0,2})/i);
    if (totalMatch) {
      total = totalMatch[1];
      break;
    }
  }
  
  // Find tax
  for (const line of lines) {
    const taxMatch = line.match(/tax.*?[\$]?(\d+\.?\d{0,2})/i);
    if (taxMatch) {
      tax = taxMatch[1];
      break;
    }
  }
  
  // Extract items
  for (const line of lines) {
    if (line.toLowerCase().includes('total') || 
        line.toLowerCase().includes('tax') || 
        line.toLowerCase().includes('change') ||
        line.toLowerCase().includes('cash')) {
      continue;
    }
    
    const itemMatch = line.match(/^(.+?)\s+[\$]?(\d+\.?\d{0,2})$/);
    if (itemMatch) {
      const itemName = itemMatch[1].trim();
      const price = itemMatch[2];
      
      if (itemName.length > 2 && parseFloat(price) < 500) {
        items.push({
          item: itemName,
          quantity: '1',
          price: `$${price}`,
          total: `$${price}`
        });
      }
    }
  }
  
  if (parseFloat(tax) > 0) {
    items.push({
      item: 'Tax',
      quantity: '',
      price: '',
      total: `$${tax}`
    });
  }
  
  items.push({
    item: 'TOTAL',
    quantity: '',
    price: '',
    total: `$${total}`
  });
  
  return { items: items };
}
