import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin'
import password from './secret'

const database = admin.firestore();

const auto = functions.https.onRequest(async (request, response) => {
    const {
        secret,
        data
    } = request.body

    if (secret === password) {
        try {
            await database.collection('laboratory').doc('labhard').set({
                open: !!data
            }, { merge: true })
            response.status(200).json({
                message: 'value updated',
                status: 'ok'
            })
        } catch (e) {
            console.error('Error setting data...')
            response.status(500).json({
                message: 'server error',
                status: 'failed'
            })
        }
    } else {
        response.status(401).json({
            message: 'invalid secret',
            status: 'failed'
        })
    }
})

export default auto;
