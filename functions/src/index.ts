import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';

admin.initializeApp();
const database = admin.firestore();
const settings = { timestampsInSnapshots: true };
database.settings(settings);

const storage = admin.storage().bucket()

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

export const adminMessages = functions.firestore.document("unes_notify_messages/{messageId}")
    .onCreate(async(snapshot) => {
        const imageUrl = snapshot.data()['image']
        const payload = {
            data: {
                identifier: 'service',
                title: snapshot.data()['title'],
                message: snapshot.data()['message'],
                ...imageUrl && { image: imageUrl }
            }
        }

        console.log(payload);

        const data = snapshot.data()
        await database.collection("unes_messages").add({
            title: data['title'],
            message: data['message'],
            image: data['image'] || null,
            link: data['link'] || 'https://github.com/ForceTower/Melon',
            createdAt: data['createdAt']
        })
        await notifyUsers(payload);
        return true;
    });

export const migrateAccount = functions.firestore.document("users/{userId}")
    .onCreate(async(snapshot) => {
        const data = snapshot.data()
        const username = data['username']
        const currId = snapshot.id
        if (username != null) {
            const usersQuery = await database.collection('users')
                .where('username', '==', username)
                .get()

            const users = usersQuery.docs
                .filter(user => user.id != currId)

            if (users != null && users.length > 0) {
                const prevId = users[0].id

                const reminders = await database.collection('users').doc(prevId).collection('reminders').get()
                reminders.docs.map(async(reminder) => {
                    const plain = reminder.data()
                    await database.collection('users').doc(currId).collection('reminders').add(plain)
                    await reminder.ref.delete()
                });

                const fileExists = await storage.file('users/' + prevId + '/avatar.jpg').exists()
                if (fileExists) {
                    try {
                    await storage.file('users/' + prevId + '/avatar.jpg').move('users/' + currId + '/avatar.jpg')
                    console.log('<< Old picture copied')
                    } catch (e) {
                        console.log('<< Guck exception')
                    }
                }
                
                await database.collection('users').doc(prevId).delete()
                try {
                    await admin.auth().deleteUser(prevId)
                } catch (e) {
                    console.log('<< Guck exception for delete account')
                }

                console.log('>> Completed migration for user ' + username)
            } else {
                console.log('>> Previous user did not match')
            }
        } else {
            console.log('>> Previous user was undefined')
        }
    });

async function notifyUsers(payload: admin.messaging.MessagingPayload) {
    const documents = await admin.firestore().collection("users").get()
    const tokens: string[] = documents.docs
        .map(val => val.data())
        .map(val => val['firebaseToken'])
        .filter(val => val != null && val.length > 0)
    
    console.log("> Size: " + tokens.length)

    const response = await admin.messaging().sendToDevice(tokens, payload)
    console.log('> Success: ' + response.successCount + '. Failed: ' + response.failureCount)
}
