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
  console.log('=== UNIVERSAL RECEIPT PARSER ===');
  console.log('Raw text:', text);
  
  const lines = text.split(/[\r\n]+/).map(line => line.trim()).filter(line => line.length > 0);
  console.log('All lines:', lines);
  
  const items = [];
  let total = '0.00';
  let tax = '0.00';
  let subtotal = '0.00';
  let store = '';
  let date = '';
  
  // === FIND STORE NAME ===
  for (let i = 0; i < Math.min(5, lines.length); i++) {
    const line = lines[i];
    if (line.length > 3 && 
        !line.match(/^\d/) && 
        !line.includes('$') &&
        !line.includes('€') &&
        !line.includes('£') &&
        !line.match(/\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4}/) &&
        !line.match(/^(receipt|bill|invoice|order)/i) &&
        !line.match(/^-+$/) &&
        line.length < 50) {
      store = line;
      break;
    }
  }
  
  // === FIND DATE ===
  const datePatterns = [
    /\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4}/,
    /\d{4}[\/\-\.]\d{1,2}[\/\-\.]\d{1,2}/,
    /(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\s+\d{1,2}[,\s]+\d{4}/i
  ];
  
  for (const line of lines) {
    for (const pattern of datePatterns) {
      const match = line.match(pattern);
      if (match) {
        date = match[0];
        break;
      }
    }
    if (date) break;
  }
  
  // === FIND TOTALS (Multiple Strategies) ===
  const totalPatterns = [
    // Standard patterns
    /total[:\s]*[$€£¥]?\s*(\d{1,6}[,.]?\d{0,3}\.?\d{2})/i,
    /grand\s*total[:\s]*[$€£¥]?\s*(\d{1,6}[,.]?\d{0,3}\.?\d{2})/i,
    /final\s*total[:\s]*[$€£¥]?\s*(\d{1,6}[,.]?\d{0,3}\.?\d{2})/i,
    /amount\s*due[:\s]*[$€£¥]?\s*(\d{1,6}[,.]?\d{0,3}\.?\d{2})/i,
    /balance[:\s]*[$€£¥]?\s*(\d{1,6}[,.]?\d{0,3}\.?\d{2})/i,
    /total\s*amount[:\s]*[$€£¥]?\s*(\d{1,6}[,.]?\d{0,3}\.?\d{2})/i,
    
    // Spaced patterns like "TOTAL           $50.00"
    /total\s+[$€£¥]\s*(\d{1,6}[,.]?\d{0,3}\.?\d{2})/i,
    /total\s+(\d{1,6}[,.]?\d{0,3}\.?\d{2})/i,
    
    // Number first patterns like "$50.00 TOTAL"
    /[$€£¥]\s*(\d{1,6}[,.]?\d{0,3}\.?\d{2})\s*total/i,
    /(\d{1,6}[,.]?\d{0,3}\.?\d{2})\s*total/i
  ];
  
  for (const line of lines) {
    for (const pattern of totalPatterns) {
      const match = line.match(pattern);
      if (match) {
        const amount = match[1].replace(/[,]/g, ''); // Remove commas
        if (parseFloat(amount) > parseFloat(total)) {
          total = amount;
          console.log('Found total:', total, 'from line:', line);
        }
      }
    }
  }
  
  // === FIND TAX ===
  const taxPatterns = [
    /tax[:\s]*[$€£¥]?\s*(\d{1,6}[,.]?\d{0,3}\.?\d{2})/i,
    /sales\s*tax[:\s]*[$€£¥]?\s*(\d{1,6}[,.]?\d{0,3}\.?\d{2})/i,
    /vat[:\s]*[$€£¥]?\s*(\d{1,6}[,.]?\d{0,3}\.?\d{2})/i,
    /gst[:\s]*[$€£¥]?\s*(\d{1,6}[,.]?\d{0,3}\.?\d{2})/i,
    /hst[:\s]*[$€£¥]?\s*(\d{1,6}[,.]?\d{0,3}\.?\d{2})/i,
    /tax\s+[$€£¥]\s*(\d{1,6}[,.]?\d{0,3}\.?\d{2})/i,
    /tax\s+(\d{1,6}[,.]?\d{0,3}\.?\d{2})/i
  ];
  
  for (const line of lines) {
    for (const pattern of taxPatterns) {
      const match = line.match(pattern);
      if (match) {
        tax = match[1].replace(/[,]/g, '');
        console.log('Found tax:', tax, 'from line:', line);
        break;
      }
    }
    if (tax !== '0.00') break;
  }
  
  // === FIND SUBTOTAL ===
  const subtotalPatterns = [
    /sub\s*total[:\s]*[$€£¥]?\s*(\d{1,6}[,.]?\d{0,3}\.?\d{2})/i,
    /subtotal[:\s]*[$€£¥]?\s*(\d{1,6}[,.]?\d{0,3}\.?\d{2})/i
  ];
  
  for (const line of lines) {
    for (const pattern of subtotalPatterns) {
      const match = line.match(pattern);
      if (match) {
        subtotal = match[1].replace(/[,]/g, '');
        console.log('Found subtotal:', subtotal);
        break;
      }
    }
    if (subtotal !== '0.00') break;
  }
  
  // === EXTRACT ITEMS (Multiple Strategies) ===
  const skipPatterns = [
    // Skip these types of lines
    /^(receipt|bill|invoice|order|thank\s*you|visit\s*us|customer|cashier)/i,
    /^(total|subtotal|tax|change|cash|card|credit|debit|visa|master|amex)/i,
    /^(payment|tender|balance|amount\s*due|grand\s*total)/i,
    /^(date|time|store|location|address|phone|website)/i,
    /^[0-9\/\-\.:]+$/, // Pure dates/times
    /^-+$|^\*+$|^=+$/, // Separator lines
    /^\s*$/, // Empty lines
    /barcode|qr\s*code|modif\.ai/i,
    /^(return|refund|exchange|policy)/i
  ];
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    console.log(`Processing line ${i}: "${line}"`);
    
    // Skip if matches skip patterns
    const shouldSkip = skipPatterns.some(pattern => pattern.test(line));
    if (shouldSkip) {
      console.log('  → Skipped (matches skip pattern)');
      continue;
    }
    
    // === STRATEGY 1: Wide spaced format ===
    // "1x Lorem ipsum                    $    35.00"
    // "Item name                         $ 5.99"
    const wideSpaced = line.match(/^(.+?)\s{3,}[$€£¥]\s*(\d{1,6}[,.]?\d{0,3}\.?\d{2})$/);
    if (wideSpaced) {
      const itemName = wideSpaced[1].trim();
      const price = wideSpaced[2].replace(/[,]/g, '');
      if (isValidItem(itemName, price)) {
        items.push(createItem(itemName, price));
        console.log('  → Added (wide spaced):', itemName, '$' + price);
        continue;
      }
    }
    
    // === STRATEGY 2: Standard formats ===
    const standardPatterns = [
      /^(.+?)\s+[$€£¥](\d{1,6}[,.]?\d{0,3}\.?\d{2})$/,  // Item $5.99
      /^(.+?)\s+(\d{1,6}[,.]?\d{0,3}\.?\d{2})$/,        // Item 5.99
      /^(.+?)[$€£¥](\d{1,6}[,.]?\d{0,3}\.?\d{2})$/,     // Item$5.99
      /^(.+?)\s*-\s*[$€£¥]?(\d{1,6}[,.]?\d{0,3}\.?\d{2})$/, // Item - $5.99
    ];
    
    for (const pattern of standardPatterns) {
      const match = line.match(pattern);
      if (match) {
        const itemName = match[1].trim();
        const price = match[2].replace(/[,]/g, '');
        if (isValidItem(itemName, price)) {
          items.push(createItem(itemName, price));
          console.log('  → Added (standard):', itemName, '$' + price);
          break;
        }
      }
    }
    
    // === STRATEGY 3: Quantity formats ===
    // "2 @ $5.99", "3x Item $15.00", "Item Qty:2 $10.00"
    const qtyPatterns = [
      /^(.+?)\s+(\d+)\s*[@x×]\s*[$€£¥]?(\d{1,6}[,.]?\d{0,3}\.?\d{2})$/i,
      /^(\d+)\s*[@x×]\s*(.+?)\s+[$€£¥]?(\d{1,6}[,.]?\d{0,3}\.?\d{2})$/i,
      /^(.+?)\s+qty[:\s]*(\d+)\s+[$€£¥]?(\d{1,6}[,.]?\d{0,3}\.?\d{2})$/i
    ];
    
    for (const pattern of qtyPatterns) {
      const match = line.match(pattern);
      if (match) {
        let itemName, quantity, price;
        if (pattern.source.startsWith('^(.+?)\\s+(\\d+)')) {
          itemName = match[1].trim();
          quantity = match[2];
          price = match[3].replace(/[,]/g, '');
        } else {
          quantity = match[1];
          itemName = match[2].trim();
          price = match[3].replace(/[,]/g, '');
        }
        
        if (isValidItem(itemName, price)) {
          items.push({
            item: itemName,
            quantity: quantity,
            price: `$${(parseFloat(price) / parseInt(quantity)).toFixed(2)}`,
            total: `$${price}`
          });
          console.log('  → Added (quantity):', itemName, 'qty:', quantity, 'total: $' + price);
          break;
        }
      }
    }
    
    // === STRATEGY 4: Multi-line items ===
    // Sometimes item name is on one line, price on next
    if (i < lines.length - 1) {
      const nextLine = lines[i + 1];
      const priceOnlyMatch = nextLine.match(/^\s*[$€£¥]?(\d{1,6}[,.]?\d{0,3}\.?\d{2})\s*$/);
      if (priceOnlyMatch && isValidItem(line, priceOnlyMatch[1])) {
        const price = priceOnlyMatch[1].replace(/[,]/g, '');
        items.push(createItem(line, price));
        console.log('  → Added (multi-line):', line, '$' + price);
        i++; // Skip the price line
        continue;
      }
    }
  }
  
  // === HELPER FUNCTIONS ===
  function isValidItem(name, price) {
    const priceNum = parseFloat(price);
    return name && name.length > 1 && 
           name.length < 100 && 
           priceNum > 0.01 && 
           priceNum < 10000 &&
           !name.match(/^\d+$/) && // Not just numbers
           !name.match(/^[$€£¥\d\s.,]+$/) && // Not just prices/numbers
           name.split(' ').length < 20; // Reasonable word count
  }
  
  function createItem(name, price) {
    return {
      item: name,
      quantity: '1',
      price: `$${price}`,
      total: `$${price}`
    };
  }
  
  // === ADD SUBTOTAL, TAX, TOTAL ===
  if (subtotal !== '0.00' && parseFloat(subtotal) > 0) {
    items.push({
      item: 'Subtotal',
      quantity: '',
      price: '',
      total: `$${subtotal}`
    });
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
  
  console.log('=== FINAL PARSED RESULT ===');
  console.log('Store:', store);
  console.log('Date:', date);
  console.log('Items found:', items.length);
  console.log('Items:', items);
  
  return {
    store: store,
    date: date,
    items: items
  };
}
