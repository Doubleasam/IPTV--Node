const express = require('express');
const bodyParser = require('body-parser');
const qrcode = require('qrcode-terminal');
const qrImage = require('qr-image');
const { Client, LocalAuth, ev } = require('whatsapp-web.js');
const cors = require('cors'); 
const path = require('path');
const fs = require('fs');
const flatted = require('flatted');
 

const app = express();
const port = process.env.PORT || 3000;

const corsOptions = {
    origin: '*',
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
    credentials: true,  
};

app.use(cors(corsOptions)); 
app.use(bodyParser.json());

const clients = new Map(); 
const qrGenerated = new Map(); 
const clientsData = [];

const clientSessionFolderPath = './client-sessions/';
 
const saveQRCodeImage = async (folderPath, fileName, base64Data) => {
    try {
        // Construct the full file path
        const filePath = path.join(folderPath, fileName);

        // Remove the "data:image/png;base64," prefix from the base64 data
        const base64Image = base64Data.replace(/^data:image\/png;base64,/, '');

        // Write the base64 data to a file
        await fs.promises.writeFile(filePath, base64Image, 'base64');

        console.log(`QR code image saved to: ${filePath}`);
        return filePath;
    } catch (error) {
        console.error('Error saving QR code image:', error.message);
        throw error;
    }
};

// Function to initialize a new WhatsApp client
const initializeClient = async (userId, res, req) => {

 
     let readyStatus = 0; // Initialize readyStatus as not ready

    const client = new Client({
        authStrategy: new LocalAuth({ clientId: userId }),
        puppeteer: {
            handleSIGINT: false,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox'
            ],
            timeout: 60000
        }
    });

    let qrCodeSent = false; // Flag to track if the QR code response has been sent

    // Attach 'qr' event handler before initializing
    console.log("WAITING QR CODE GENERATION"); 
    client.on('qr', async qr => {
        qrcode.generate(qr, {
            small: true
        });
            console.log("QR CODE GENERATED");

            // Convert QR code to PNG image
            const qrImageBuffer = qrImage.imageSync(qr, { type: 'png' });
            const qrImageBase64 = qrImageBuffer.toString('base64');

            // Save QR code image to the server
            const folderPath = path.join(__dirname, 'qrcodes');  
            const fileName = `${userId}_qrcode.png`;

            // Create the folder if it doesn't exist
            if (!fs.existsSync(folderPath)) {
                fs.mkdirSync(folderPath);
            }

            await saveQRCodeImage(folderPath, fileName, qrImageBase64);

        
            if (!qrCodeSent) {
                // Construct the public URL
                const publicUrl = `${req.protocol}://${req.get('host')}/qrcodes/${fileName}`;
                // const publicUrl = `${req.protocol}://${req.get('host')}/whatsapp-app/qrcodes/${fileName}`;

                // Send the public URL to the client
                res.json({ success: true, qrCode: publicUrl });
                qrGenerated.set(userId, true);
                qrCodeSent = true; // Set the flag to true to indicate that the response has been sent
            }
    });

    console.log("CLIENT IS  READY");
    client.on('ready', () => {
        
        console.log(`WhatsApp client for user ${userId} is ready!`);
        readyStatus = 1

        console.log("CLIENT IS  ADDED TO TRAY 2");
        clients.set(userId, client);   
        clientsData.push({ userId, client })
    });

    client.on('message', async message => {
        console.log(`New message for user ${userId}!`);

        if (message.body === '!ping') {
            message.reply('pong');
        }
    });
 

    // Attach an error event handler
    client.on('error', error => {
        console.error(`WhatsApp client for user ${userId} encountered an error:`, error);
    });

    // Initialize WhatsApp client after attaching event handlers
    client.initialize();

 // Wait until the client is ready
    while (readyStatus === 1) {  

        console.log("CLIENT IS  ADDED TO TRAY");
        clients.set(userId, client);  
 
    }

};

// expose the qr codes to the public user
app.use('/qrcodes', express.static(path.join(__dirname, 'qrcodes')));


// API endpoint to check if client exist
app.post('/verify', (req, res) => { 
    const { userId } = req.body;
    // let client = clients.get(userId);
    const client = clientsData.find(user => user.userId === userId);
 
    if (client) { 
        // If the client already exists, send a success response without generating a new QR code
        res.json({ authenticated: true });
    }else{
        res.json({ authenticated: false });
    }
})


// API endpoint to check if client exist
app.post('/disconnect', async (req, res) => {
    const { userId } = req.body;

    if (!userId) {
        return res.status(400).send('User ID is required.');
    }
   
    //#########################################################

      const clientItem = clientsData.find(user => user.userId === userId);
      const { client } = clientItem;
 
      if (!clientItem) {
        console.log("clientItem is not found in the array:", userId); 
          return res.status(101).json('clientItem is not found in the array');
       }
 
     try{
        // await client.logout();
        await client.destroy(); 
        
        //remove from array after destroying session 
        clientsData.splice(clientItem, 1); 
        //delete from old map
        clients.delete(client);

       return await initializeClient(userId, res, req); 
      }catch(error){ 
        console.error('Error authenticating user:', error.message);
        return res.status(500).json(error.message );
      } 
})


// API endpoint to authenticate and get a QR code
app.post('/authenticate', async (req, res) => {
    try {
        const { userId } = req.body;

        console.log("userId", userId)

        // Validate request data
        if (!userId) {
            return res.status(400).json({ error: 'userId is required' });
        }

        // Check if a client exists for the given user
        // let client = clients.get(userId); 
        const client = clientsData.find(user => user.userId === userId);

        //check if qr code has been generated before
        let qrGenStatus = qrGenerated.get(userId);

        // If client doesn't exist, initialize a new one
        if (!client && !qrGenStatus) {
            console.error("client doesn't exist");
            await initializeClient(userId, res, req); 
        } else {
            console.error("client exist");
            // If the client already exists, send a success response without generating a new QR code
            res.json({ success: true });
        }
    } catch (error) {
        console.error('Error authenticating user:', error.message);
        return res.status(500).json({ error: 'Internal Server Error' });
    }
});

// API endpoint to send WhatsApp messages
app.post('/send-message', async(req, res) => {
    try {
        const { userId, number, message } = req.body;

        // Validate request data
        if (!userId || !number || !message) {
            return res.status(400).json({ error: 'userId, number, and message are required' });
        }

        // Check if a client exists for the given user
        // let client = clients.get(userId);
        const clientItem = clientsData.find(user => user.userId === userId);
        const { client } = clientItem;

        console.log("client", { client, userId, number, message })
        // If client doesn't exist, return an error
        if (!client) {
            return res.status(401).json({ error: 'User is not authenticated. Please authenticate first.' });
        }

        // Ensure the WhatsApp client is ready
        if (!client.isReady) {
            // Getting chatId from the number.
            const chatId = number.substring(1) + "@c.us";

            // Sending message.
            client.sendMessage(chatId, message);

            return res.json({ success: true });
        } else {
            return res.status(500).json({ error: `WhatsApp client for user ${userId} is not ready` });
        }
    } catch (error) {
        console.error('Error sending message:', error.message);
        return res.status(500).json({ error: 'Internal Server Error' });
    }
});

 

app.listen(port, () => {
    console.log(`Server is running at http://localhost:${port}`);
});
