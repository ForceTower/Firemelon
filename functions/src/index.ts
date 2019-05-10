import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';

admin.initializeApp();
const database = admin.firestore();
const settings = { timestampsInSnapshots: true };
database.settings(settings);

import notifier from './feedback/notifier';

const storage = admin.storage().bucket()

export {
    notifier
}

export const sendDarkTheme = functions.https.onCall(async(data, context) => {
    const username = data.username

    if (!context.auth) {
        throw new functions.https.HttpsError('unauthenticated', 'The function must be called while authenticated.');
    }

    if (!username) {
        throw new functions.https.HttpsError('unimplemented', 'This new version requires a username. Random send has been deprecated')
    }

    const uid = context.auth.uid;
    const me = await database.collection('users').doc(uid).get()
    const name = me.data()['name']
    const invites = me.data()['darkInvites'] || 0
    const sentInvites = me.data()['sentDarkInvites'] || 0

    if (sentInvites >= invites) {
        console.log(`${name} tried to invite someone and had no invites`)
        throw new functions.https.HttpsError('failed-precondition', 'You have no invites left');
    }

    let receiverQuery: FirebaseFirestore.QuerySnapshot
    if (username) {
        receiverQuery = await database.collection('users').where('username', '==', username).limit(1).get()
    } else {
        receiverQuery = await database.collection('users').where('darkThemeEnabled', '==', false).get()
    }
    if (receiverQuery.empty) {
        console.log(`${name} tried to invite an unknown person`)
        throw new functions.https.HttpsError('not-found', `Username ${username} was not found`)
    }

    let receiver: FirebaseFirestore.QueryDocumentSnapshot
    if (username) {
        receiver = receiverQuery.docs[0]
    } else {
        const random = Math.floor(Math.random() * receiverQuery.size)
        receiver = receiverQuery.docs[random]
    }
    const token = receiver.data()['firebaseToken']
    const recName = receiver.data()['name']
    await receiver.ref.set({ darkThemeEnabled: true }, { merge: true })
    await me.ref.set({ sentDarkInvites: (sentInvites + 1) }, { merge: true })
    await notifyUser(token, {
        data: {
            identifier: 'service',
            title: 'Você recebeu um presente!',
            message: `${name} acabou de desbloquear o tema escuro para você`
        }
    })

    console.log(`Dark theme send complete from ${name} to ${recName}`)

    return {
        success: true,
        message: `Dark theme send complete from ${name} to ${username}`
    }
});

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
        const data = snapshot.data()
        const imageUrl = data['image'] || null
        const institution = data['institution'] || null
        const payload = {
            data: {
                identifier: 'service',
                title: data['title'],
                message: data['message'],
            }
        }

        if (imageUrl) {
            payload.data['image'] = imageUrl
        }
        if (institution) {
            payload.data['institution'] = institution
        }

        await database.collection("unes_messages").add({
            title: data['title'],
            message: data['message'],
            image: data['image'] || null,
            link: data['link'] || 'https://github.com/ForceTower/Melon',
            createdAt: data['createdAt'],
            institution: data['institution']
        })
        await notifyUsers(payload);
        return true;
    });

export const migrateAccount = functions.firestore.document("users/{userId}")
    .onCreate(async(snapshot) => {
        const data = snapshot.data()
        const username = data['username']
        const currId = snapshot.id
        if (username) {
            const usersQuery = await database.collection('users')
                .where('username', '==', username)
                .get()

            const users = usersQuery.docs
                .filter(value => value.id !== currId)

            if (users && users.length > 0) {
                const prevId = users[0].id
                const oldData = users[0].data()
                const {
                    darkInvites,
                    darkThemeEnabled,
                    sentDarkInvites
                } = oldData

                try {
                    await snapshot.ref.set({
                        darkInvites: darkInvites || 0,
                        darkThemeEnabled: darkThemeEnabled || false,
                        sentDarkInvites: sentDarkInvites || 0
                    }, { merge: true })
                } catch (error) {}

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

export const updateProfile = functions.firestore.document("users/{userId}")
    .onUpdate(snapshot => {
        const after = snapshot.after.data()
        const before = snapshot.before.data()

        const { darkThemeEnabled: beforeDark } = before
        const { darkThemeEnabled: afterDark } = after
        const darkEnabled = beforeDark || afterDark

        if (beforeDark && !afterDark) {
            snapshot.after.ref.set({ darkThemeEnabled: darkEnabled }, { merge: true })
        }
        return true
    });

async function notifyUsers(payload: admin.messaging.MessagingPayload, topic: string = 'general') {
    const response = await admin.messaging().sendToTopic(topic, payload, {
        priority: 'high'
    });
    console.log(`Success. ${response.messageId}`)
}

async function notifyUser(token: string, payload: admin.messaging.MessagingPayload) {
    const response = await admin.messaging().sendToDevice(token, payload, {
        priority: 'high'
    })
    console.log(`Success. ${response.successCount}`)
}

async function createNotifyMessage(payload: any) {
    try {
        await database.collection('unes_notify_messages').add(payload)
    } catch (err) {
        console.error(err)
    }
}