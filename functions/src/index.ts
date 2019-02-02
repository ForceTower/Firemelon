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

export const findUserId = functions.https.onCall(async(data, context) => {
    const username = data.username
    if (!username) {
        throw new functions.https.HttpsError('failed-precondition', 'Username was not specified')
    }

    const query = await database.collection('users').where('username', '==', username).limit(1).get()
    const ids = query.docs.map(it => {
        return {
            id: it.id,
            token: it.data()['firebaseToken']
        }
    })
    return { ids }
})

export const sendDarkTheme = functions.https.onCall(async(data, context) => {
    const username = data.username

    if (!context.auth) {
        throw new functions.https.HttpsError('unauthenticated', 'The function must be called while authenticated.');
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
        if (username) {
            const usersQuery = await database.collection('users')
                .where('username', '==', username)
                .get()

            const users = usersQuery.docs
                .filter(value => value.id !== currId)

            if (users && users.length > 0) {
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

export const statsContribution = functions.firestore.document("stats_contributions/{userId}")
    .onCreate(async(snapshot) => {
        const data = snapshot.data();
        const disciplines = data['disciplines']

        disciplines.forEach(async(element) => {
            const code = element['code']
            const discName = element['disciplineName'].toLowerCase()
            const teacher = element['teacher'].toLowerCase()
            const teacherKey = teacher.replace(/\s/g, "")
            const semester = element['semester']
            const grade = element['grade']

            const contributorData = {
                user: snapshot.id
            }

            const teacherRef = database.collection('stats_teachers').doc(teacherKey)
            const teacherDoc = await teacherRef.get()
            let teacherData = {}
            if (!teacherDoc.exists) {
                teacherData = {
                    name: teacher,
                    average: grade,
                    total: 1
                }
            } else {
                teacherData = {
                    average: (teacherDoc.data()['average'] + grade)/2,
                    total: teacherDoc.data()['total'] + 1
                }
            }
            await teacherRef.set(teacherData)
            await teacherRef.collection('contributors').doc(snapshot.id).set(contributorData)

            const semesterRef = teacherRef.collection('semesters').doc(semester)
            const semesterDoc = await semesterRef.get()
            let semesterData = {};
            if (!semesterDoc.exists) {
                semesterData = {
                    average: grade,
                    total: 1,
                }
            } else {
                semesterData = {
                    average: (semesterDoc.data()['average'] + grade)/2,
                    total: semesterDoc.data()['total'] + 1
                }
            }
            await semesterRef.set(semesterData)
            await semesterRef.collection('contributors').doc(snapshot.id).set(contributorData);

            const discRef = teacherRef.collection('disciplines').doc(code)
            const discDoc = await discRef.get()
            let discData = {}
            if (!discDoc.exists) {
                discData = {
                    name: discName,
                    average: grade,
                    total: 1
                }
            } else {
                discData = {
                    average: (discDoc.data()['average'] + grade)/2,
                    total: discDoc.data()['total'] + 1
                }
            }
            await discRef.set(discData)
            await discRef.collection('contributors').doc(snapshot.id).set(contributorData);

            const discStRef = database.collection('stats_disciplines').doc(code)
            const discStatDoc = await discStRef.get()
            let discStatData = {}
            if (!discStatDoc.exists) {
                discStatData = {
                    name: discName,
                    average: grade,
                    total: 1
                }
            } else {
                discStatData = {
                    average: (discStatDoc.data()['average'] + grade)/2,
                    total: discStatDoc.data()['total'] + 1
                }
            }
            await discStRef.set(discStatData)
            await discStRef.collection('contributors').doc(snapshot.id).set(contributorData);

            const discStTchRef = discStRef.collection('teachers').doc(teacherKey)
            const discStTchDoc = await discStTchRef.get()
            let discStTchData = {}
            if (!discStTchDoc.exists) {
                discStTchData = {
                    name: teacher,
                    average: grade,
                    total: 1
                }
            } else {
                discStTchData = {
                    average: (discStTchDoc.data()['average'] + grade)/2,
                    total: discStTchDoc.data()['total'] + 1
                }
            }
            await discStTchRef.set(discStTchData)
            await discStTchRef.collection('contributors').doc(snapshot.id).set(contributorData);

            const discStTchSmtRef = discStTchRef.collection('semester').doc(semester)
            const discStTchSmtDoc = await discStTchSmtRef.get()
            let discStTchSmtData = {}
            if (!discStTchSmtDoc.exists) {
                discStTchSmtData = {
                    average: grade,
                    total: 1
                }
            } else {
                discStTchSmtData = {
                    average: (discStTchSmtDoc.data()['average'] + grade)/2,
                    total: discStTchSmtDoc.data()['total'] + 1
                }
            }
            await discStTchSmtRef.set(discStTchSmtData)
            await discStTchSmtRef.collection('contributors').doc(snapshot.id).set(contributorData);

            const discStSmtRef = discStRef.collection('semester').doc(semester)
            const discStSmtDoc = await discStSmtRef.get()
            let discStSmtData = {}
            if (!discStSmtDoc.exists) {
                discStSmtData = {
                    average: grade,
                    total: 1
                }
            } else {
                discStSmtData = {
                    average: (discStSmtDoc.data()['average'] + grade)/2,
                    total: discStSmtDoc.data()['total'] + 1
                }
            }
            await discStSmtRef.set(discStSmtData)
            await discStSmtRef.collection('contributors').doc(snapshot.id).set(contributorData);
        });
    })

async function notifyUsers(payload: admin.messaging.MessagingPayload) {
    const response = await admin.messaging().sendToTopic('general', payload, {
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
