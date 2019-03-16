import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';

const database = admin.firestore();

const notifier = functions.firestore.document("feedback_first/{feedbackId}").onCreate(async(snapshot) => {
    const data = snapshot.data()
    const payload = {
        data: {
            identifier: 'service',
            title: `UNES Feedback: ${data['username']}`,
            message: `${data['text']}\n\n${data['email']} - ${data['versionCode']} - ${data['course']}`
        }
    }

    const creator = await database.collection('users').doc('HHWS8lanQIgE0KJKvZZiKjSOdwC3').get()
    const token = creator.data()['firebaseToken']
    await admin.messaging().sendToDevice(token, payload)
})

export default notifier