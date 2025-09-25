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
    
    // Remove data:image/jpeg;base64, prefix if present
    const base64Image = imageData.includes(',') ? imageData.split(',')[1] : imageData;
    
    console.log('Processing with Google Vision API...');
    
    // Call Google Vision API
    const response = await fetch(`https://vision.googleapis.com/v1/images:annotate?key=${process.env.GOOGLE_VISION_API_KEY}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        requests: [{
          image: {
            content: base64Image
          },
          features: [{
            type: 'TEXT_DETECTION',
            maxResults: 1
          }]
        }]
      })
    });

    const result = await response.json();
    console.log('Google Vision Result:', JSON.stringify(result, null, 2));
    
    // Check for errors
    if (result.error) {
      console.error('Google Vision API Error:', result.error);
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ 
          success: false, 
          error: `Google Vision API Error: ${result.error.message}` 
        })
      };
    }
    
    if (result.responses && result.responses[0] && result.responses[0].textAnnotations) {
      const extractedText = result.responses[0].textAnnotations[0].description;
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
      console.log('No text found in response:', result);
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ 
          success: false, 
          error: 'No text found in image. Try a clearer photo with better lighting.',
          debug: result.responses ? result.responses[0] : result
        })
      };
    }
    
  } catch (error) {
    console.error('Processing Error:', error);
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
  console.log('Parsing receipt text:', text);
  
  const lines = text.split('\n').map(line => line.trim()).filter(line => line.length > 0);
  console.log('Parsed lines:', lines);
  
  const items = [];
  let total = '0.00';
  let tax = '0.00';
  let store = '';
  let date = '';
  
  // Find store name (usually first few non-empty lines)
  for (let i = 0; i < Math.min(3, lines.length); i++) {
    if (lines[i].length > 3 && 
        !lines[i].match(/^\d/) && 
        !lines[i].includes('$') &&
        !lines[i].match(/\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}/)) {
      store = lines[i];
      break;
    }
  }
  
  // Find date
  const dateRegex = /\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}/;
  for (const line of lines) {
    const dateMatch = line.match(dateRegex);
    if (dateMatch) {
      date = dateMatch[0];
      break;
    }
  }
  
  // Find total with multiple patterns
  const totalPatterns = [
    /total.*?(\d+\.?\d{2})/i,
    /^total\s+\$?(\d+\.?\d{2})/i,
    /(\d+\.?\d{2})\s*total/i,
    /balance.*?(\d+\.?\d{2})/i
  ];
  
  for (const line of lines) {
    for (const pattern of totalPatterns) {
      const match = line.match(pattern);
      if (match && parseFloat(match[1]) > 0) {
        total = match[1];
        console.log('Found total:', total, 'from line:', line);
        break;
      }
    }
    if (total !== '0.00') break;
  }
  
  // Find tax
  const taxPatterns = [
    /tax.*?(\d+\.?\d{2})/i,
    /^tax\s+\$?(\d+\.?\d{2})/i
  ];
  
  for (const line of lines) {
    for (const pattern of taxPatterns) {
      const match = line.match(pattern);
      if (match) {
        tax = match[1];
        console.log('Found tax:', tax, 'from line:', line);
        break;
      }
    }
    if (tax !== '0.00') break;
  }
  
  // Extract line items
  for (const line of lines) {
    // Skip lines that are clearly not items
    const skipPatterns = [
      /total/i, /tax/i, /change/i, /cash/i, /card/i, /visa/i, /master/i,
      /credit/i, /debit/i, /payment/i, /tender/i, /balance/i, /subtotal/i,
      /^\d{1,2}[\/\-]\d{1,2}/, // dates
      /^[a-zA-Z\s]*$/, // only letters (store names, etc)
      /^\d+$/ // only numbers
    ];
    
    const shouldSkip = skipPatterns.some(pattern => pattern.test(line));
    if (shouldSkip) continue;
    
    // Try multiple patterns for items with prices
    const itemPatterns = [
      /^(.+?)\s+\$(\d+\.?\d{2})$/,           // Item $5.99
      /^(.+?)\s+(\d+\.\d{2})$/,              // Item 5.99
      /^(.+?)\$(\d+\.?\d{2})/,               // Item$5.99
      /(\w.+?)\s+(\d+\.\d{2})\s*$/,          // Item 5.99 (word start)
      /^([A-Za-z].+?)\s+(\d+\.?\d{1,2})$/    // Letter start Item 5.99
    ];
    
    for (const pattern of itemPatterns) {
      const match = line.match(pattern);
      if (match) {
        const itemName = match[1].trim();
        const price = match[2];
        const priceNum = parseFloat(price);
        
        // Filter reasonable items
        if (itemName.length > 2 && 
            priceNum > 0.01 && 
            priceNum < 1000 &&
            !itemName.match(/^\d+$/) &&
            itemName.length < 50) {
          
          items.push({
            item: itemName,
            quantity: '1',
            price: `$${price}`,
            total: `$${price}`
          });
          console.log('Added item:', itemName, '$' + price);
          break;
        }
      }
    }
  }
  
  // If no items found, try a simpler approach
  if (items.length === 0) {
    console.log('No items found with strict patterns, trying broader search...');
    
    for (const line of lines) {
      // Look for any line containing both text and a number that looks like money
      const match = line.match(/(.+?)\s+(\d{1,3}\.\d{2})/);
      if (match && !line.toLowerCase().includes('total')) {
        const itemName = match[1].trim();
        const price = match[2];
        
        if (itemName.length > 1 && parseFloat(price) < 100) {
          items.push({
            item: itemName,
            quantity: '1',
            price: `$${price}`,
            total: `$${price}`
          });
          console.log('Added fallback item:', itemName, '$' + price);
        }
      }
    }
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
  
  return {
    store: store,
    date: date,
    items: items
  };
}
