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
    
    console.log('Processing image...');
    
    // Create URL-encoded form data
    const formBody = new URLSearchParams();
    formBody.append('base64Image', imageData);
    formBody.append('language', 'eng');
    formBody.append('isOverlayRequired', 'false');
    formBody.append('apikey', 'helloworld');
    formBody.append('OCREngine', '2');
    
    const response = await fetch('https://api.ocr.space/parse/image', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: formBody.toString()
    });

    const result = await response.json();
    console.log('OCR Result:', JSON.stringify(result, null, 2));
    
    if (result.ParsedResults && result.ParsedResults[0] && result.ParsedResults[0].ParsedText) {
      const extractedText = result.ParsedResults[0].ParsedText;
      console.log('Extracted text:', extractedText);
      
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
      console.log('No text found. Full result:', result);
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ 
          success: false, 
          error: 'No text found in image. Try a clearer photo with better lighting.',
          debug: result
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
        error: `Processing failed: ${error.message}` 
      })
    };
  }
};

function parseReceiptText(text) {
  console.log('Parsing text:', text);
  
  const lines = text.split(/[\r\n]+/).map(line => line.trim()).filter(line => line.length > 0);
  console.log('Lines:', lines);
  
  const items = [];
  let total = '0.00';
  let tax = '0.00';
  
  // Find total (more flexible patterns)
  for (const line of lines) {
    const totalPatterns = [
      /total.*?(\d+\.?\d{2})/i,
      /^total\s+\$?(\d+\.?\d{2})/i,
      /(\d+\.?\d{2})\s*total/i
    ];
    
    for (const pattern of totalPatterns) {
      const match = line.match(pattern);
      if (match) {
        total = match[1];
        console.log('Found total:', total, 'from line:', line);
        break;
      }
    }
    if (total !== '0.00') break;
  }
  
  // Find tax
  for (const line of lines) {
    const taxMatch = line.match(/tax.*?(\d+\.?\d{2})/i);
    if (taxMatch) {
      tax = taxMatch[1];
      console.log('Found tax:', tax);
      break;
    }
  }
  
  // Extract line items (more flexible)
  for (const line of lines) {
    // Skip obvious non-items
    if (line.toLowerCase().includes('total') || 
        line.toLowerCase().includes('tax') || 
        line.toLowerCase().includes('change') ||
        line.toLowerCase().includes('cash') ||
        line.toLowerCase().includes('card') ||
        line.toLowerCase().includes('visa') ||
        line.toLowerCase().includes('master')) {
      continue;
    }
    
    // Try multiple patterns for items with prices
    const patterns = [
      /^(.+?)\s+\$(\d+\.?\d{2})$/,           // Item $5.99
      /^(.+?)\s+(\d+\.?\d{2})$/,             // Item 5.99
      /^(.+?)\$(\d+\.?\d{2})/,               // Item$5.99
      /^(.+?)\s+(\d+\.\d{2})\s*$/            // Item 5.99 (with spaces)
    ];
    
    for (const pattern of patterns) {
      const match = line.match(pattern);
      if (match) {
        const itemName = match[1].trim();
        const price = match[2];
        
        // Filter reasonable items
        if (itemName.length > 1 && 
            parseFloat(price) > 0 && 
            parseFloat(price) < 1000 &&
            !itemName.match(/^\d+$/)) {
          
          items.push({
            item: itemName,
            quantity: '1',
            price: `$${price}`,
            total: `$${price}`
          });
          console.log('Added item:', itemName, price);
          break;
        }
      }
    }
  }
  
  // If no items found, add some example data so user knows it's working
  if (items.length === 0) {
    items.push({
      item: 'Item not clearly readable',
      quantity: '1',
      price: '$0.00',
      total: '$0.00'
    });
  }
  
  // Add tax if found
  if (parseFloat(tax) > 0) {
    items.push({
      item: 'Tax',
      quantity: '',
      price: '',
      total: `$${tax}`
    });
  }
  
  // Add total
  items.push({
    item: 'TOTAL',
    quantity: '',
    price: '',
    total: `$${total}`
  });
  
  return { items: items };
}
