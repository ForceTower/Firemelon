import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';

admin.initializeApp();
const database = admin.firestore();
const settings = { timestampsInSnapshots: true };
database.settings(settings);

export const eventsUpdate = functions.firestore
    .document("events/{eventId}")
    .onUpdate(async(snapshot) => {
        const after = snapshot.after.data()
        const before = snapshot.before.data()
        if (after['approved'] && !before['approved']) {
            const payload = {
                data: {
                    identifier: 'event',
                    eventId: snapshot.after.id,
                    title: after['title'],
                    description: after['description'],
                    image: after['imageUrl'] || null
                }
            }
            await notifyUsers(payload)
            return true
        } else {
            console.log("> Not a valid approval change")
            return true
        }
    });

export const adminMessages = functions.firestore.document("unes_messages/{messageId}")
    .onCreate(async(snapshot) => {
        const payload = {
            data: {
                identifier: 'service',
                title: snapshot.data()['title'],
                message: snapshot.data()['message'],
                image: snapshot.data()['image'] || null
            }
        }
        await notifyUsers(payload);
        return true;
    });

async function notifyUsers(payload: admin.messaging.MessagingPayload) {
    const documents = await admin.firestore().collection("users").get()
    const tokens: string[] = documents.docs
        .map(val => val.data())
        .map(val => val['firebaseToken'])
        .filter(val => val != null)
        .filter(val => val.length > 0)
    
    console.log("> Size: " + tokens.length)

    const response = await admin.messaging().sendToDevice(tokens, payload)
    console.log('> Success: ' + response.successCount + '. Failed: ' + response.failureCount)
}
