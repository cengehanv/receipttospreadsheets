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
  console.log('=== FRAGMENTED RECEIPT PARSER ===');
  console.log('Raw text:', text);
  
  const lines = text.split(/[\r\n]+/).map(line => line.trim()).filter(line => line.length > 0);
  console.log('All lines:', lines);
  
  const items = [];
  let total = '0.00';
  let tax = '0.00';
  let store = '';
  let date = '';
  
  // === FIND STORE NAME ===
  for (let i = 0; i < Math.min(5, lines.length); i++) {
    const line = lines[i];
    if (line.length > 3 && 
        !line.includes('$') &&
        !line.match(/^\d/) &&
        !line.match(/^(receipt|total|cash|change|thank)/i) &&
        line.length < 50) {
      store = line;
      break;
    }
  }
  
  // === FIND TOTAL - HANDLE FRAGMENTED FORMAT ===
  // Look for "TOTAL AMOUNT" followed by "$ 117.00" later
  let totalAmountIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].match(/total\s*amount/i)) {
      totalAmountIndex = i;
      break;
    }
  }
  
  if (totalAmountIndex >= 0) {
    // Look for the price after "TOTAL AMOUNT"
    for (let i = totalAmountIndex + 1; i < Math.min(totalAmountIndex + 10, lines.length); i++) {
      const line = lines[i];
      const priceMatch = line.match(/^\$?\s*(\d{1,6}\.?\d{0,2})$/);
      if (priceMatch) {
        const amount = priceMatch[1];
        if (parseFloat(amount) > 10) { // Reasonable total
          total = amount;
          console.log('Found fragmented total:', total, 'at line', i);
          break;
        }
      }
    }
  }
  
  // Fallback: look for any large amount that could be total
  if (total === '0.00') {
    for (const line of lines) {
      const match = line.match(/^\$?\s*(\d{2,4}\.?\d{0,2})$/);
      if (match) {
        const amount = parseFloat(match[1]);
        if (amount > 50 && amount < 10000) { // Reasonable total range
          total = match[1];
          console.log('Found fallback total:', total);
          break;
        }
      }
    }
  }
  
  // === EXTRACT ITEMS - FRAGMENTED FORMAT ===
  // Strategy: Find item lines (containing "x" and text), then look ahead for prices
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    console.log(`Processing line ${i}: "${line}"`);
    
    // Look for item patterns like "1x Lorem ipsum", "2x Lorem ipsum"
    const itemMatch = line.match(/^(\d+)x\s+(.+)$/);
    if (itemMatch) {
      const quantity = itemMatch[1];
      const itemName = itemMatch[2].trim();
      
      console.log('  → Found item pattern:', quantity + 'x', itemName);
      
      // Now look ahead for the price (within next 5 lines)
      let itemPrice = null;
      
      for (let j = i + 1; j < Math.min(i + 6, lines.length); j++) {
        const nextLine = lines[j];
        
        // Skip certain lines when looking for price
        if (nextLine.match(/^(total|cash|change|thank|receipt)/i) ||
            nextLine.match(/^\d+x\s+/)) { // Another item started
          break;
        }
        
        // Look for price patterns
        const pricePatterns = [
          /^\$?\s*(\d{1,3}\.?\d{2})$/,        // "35.00" or "$35.00"
          /^\$\s+(\d{1,3}\.?\d{2})$/,        // "$ 35.00"  
          /^(\d{1,3}\.?\d{2})\s*$/           // "35.00 "
        ];
        
        for (const pattern of pricePatterns) {
          const priceMatch = nextLine.match(pattern);
          if (priceMatch) {
            const price = priceMatch[1];
            const priceNum = parseFloat(price);
            
            // Validate reasonable price range
            if (priceNum >= 0.01 && priceNum <= 1000) {
              itemPrice = price;
              console.log('  → Found price for', itemName + ':', '$' + price, 'at line', j);
              break;
            }
          }
        }
        
        if (itemPrice) break;
      }
      
      // If we found a valid price, add the item
      if (itemPrice) {
        const totalPrice = (parseFloat(itemPrice) * parseInt(quantity)).toFixed(2);
        items.push({
          item: `${quantity}x ${itemName}`,
          quantity: quantity,
          price: `$${itemPrice}`,
          total: `$${totalPrice}`
        });
        console.log('  ✓ Added item:', `${quantity}x ${itemName}`, 'price:', '$' + itemPrice, 'total:', '$' + totalPrice);
      } else {
        console.log('  ✗ No price found for:', itemName);
      }
      
      continue;
    }
    
    // === FALLBACK: Single items without quantity ===
    // Look for non-item lines that might be product names
    if (line.length > 3 && 
        !line.match(/^[\d\$\.\s]+$/) && // Not just numbers/prices
        !line.match(/^(receipt|total|cash|change|thank)/i) &&
        !line.includes('modif.ai') &&
        line.length < 50) {
      
      // Look ahead for a price
      for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
        const nextLine = lines[j];
        const priceMatch = nextLine.match(/^\$?\s*(\d{1,3}\.?\d{2})$/);
        
        if (priceMatch) {
          const price = priceMatch[1];
          const priceNum = parseFloat(price);
          
          if (priceNum >= 0.01 && priceNum <= 1000) {
            items.push({
              item: line,
              quantity: '1',
              price: `$${price}`,
              total: `$${price}`
            });
            console.log('  ✓ Added fallback item:', line, '$' + price);
            break;
          }
        }
      }
    }
  }
  
  // === ADD TOTAL ===
  items.push({
    item: 'TOTAL',
    quantity: '',
    price: '',
    total: `$${total}`
  });
  
  console.log('=== FINAL PARSED RESULT ===');
  console.log('Store:', store);
  console.log('Total items found:', items.length - 1); // Minus the total row
  console.log('Items:', items);
  
  return {
    store: store,
    date: date,
    items: items
  };
}
