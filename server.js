import express from 'express'
import cors from 'cors'
import { google } from 'googleapis'
import multer from 'multer'
import fs from 'fs'
import path from 'path'

const RESUME_FOLDER = process.env.RESUME_FOLDER || '/tmp/resumes'
if (!fs.existsSync(RESUME_FOLDER)) fs.mkdirSync(RESUME_FOLDER, { recursive: true })

const app = express()
app.use(cors())

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } })

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET
const SHEETS_REFRESH_TOKEN = process.env.SHEETS_REFRESH_TOKEN
const GMAIL_REFRESH_TOKEN = process.env.GMAIL_REFRESH_TOKEN
const CAREERS_REFRESH_TOKEN = process.env.CAREERS_REFRESH_TOKEN

const SHEET_ID = process.env.SPREADSHEET_ID || '1kPv3qrVJbo2yJk1ECt-op-3_bRn9F7ngFs2qcSugMy8'

app.get('/debug', (req, res) => {
  res.json({
    CLIENT_ID: CLIENT_ID ? CLIENT_ID.slice(0,10) : null,
    CLIENT_SECRET: CLIENT_SECRET ? CLIENT_SECRET.slice(0,10) : null,
    SHEETS_REFRESH_TOKEN: SHEETS_REFRESH_TOKEN ? SHEETS_REFRESH_TOKEN.slice(0,20) : null,
    CAREERS_REFRESH_TOKEN: CAREERS_REFRESH_TOKEN ? CAREERS_REFRESH_TOKEN.slice(0,20) : null,
    SHEET_ID: SHEET_ID ? SHEET_ID.slice(0,10) : null
  })
})

function getSheetsClient() {
  const auth = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET)
  auth.setCredentials({ refresh_token: SHEETS_REFRESH_TOKEN })
  return google.sheets({ version: 'v4', auth })
}

function getGmailClient(refreshToken) {
  const auth = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET)
  auth.setCredentials({ refresh_token: refreshToken })
  return google.gmail({ version: 'v1', auth })
}

function encodeSubject(subject) {
  return `=?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`
}

function makeEmail({ to, from, subject, body }) {
  const toClean = (to || '').trim()
  const msg = [
    `From: USNurse Direct <${from}>`,
    `To: ${toClean}`,
    `Subject: ${encodeSubject(subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    '',
    body
  ].join('\r\n')
  return Buffer.from(msg).toString('base64url')
}

function makeEmailWithAttachment({ to, from, subject, body, attachment }) {
  const toClean = (to || '').trim()
  const boundary = 'boundary_' + Date.now()
  const attachmentBase64 = attachment.buffer.toString('base64')
  const lines = [
    `From: USNurse Direct <${from}>`,
    `To: ${toClean}`,
    `Subject: ${encodeSubject(subject)}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    '',
    body,
    '',
    `--${boundary}`,
    `Content-Type: application/octet-stream; name="${attachment.originalname}"`,
    'Content-Transfer-Encoding: base64',
    `Content-Disposition: attachment; filename="${attachment.originalname}"`,
    '',
    attachmentBase64,
    '',
    `--${boundary}--`
  ]
  return Buffer.from(lines.join('\r\n')).toString('base64url')
}

app.post('/api/apply', upload.single('resume'), async (req, res) => {
  try {
    const f = req.body
    const resumeFile = req.file
    const now = new Date()
    const date = now.toLocaleDateString('en-US', { timeZone: 'America/Chicago', year: 'numeric', month: 'long', day: 'numeric' })
    const time = now.toLocaleTimeString('en-US', { timeZone: 'America/Chicago', hour: '2-digit', minute: '2-digit' })

    const row = [
      date, time,
      f.firstName || '', f.lastName || '',
      f.email || '', f.phone || '', f.messenger || '',
      f.currentLocation || '', f.currentEmployer || '',
      f.nclex || '', f.priorityDate || '', f.priorityDateStatus || '',
      f.usLicense || '', f.usLicenseState || '',
      f.englishExam || '', f.visaScreen || '',
      f.state1 || '', f.state2 || '', f.state3 || '',
      f.familyInUS || '', f.familyLocation || '',
      f.nursingExperience || '',
      f.maritalStatus || '', f.children || '',
      f.priorContract || '', f.priorContractExplanation || '',
      f.preferredContact || '', f.availableDays || ''
    ]

    // Save resume locally
    if (resumeFile) {
      const safeName = `${now.toISOString().slice(0,10)}_${Date.now()}_${f.firstName || 'Unknown'}_${f.lastName || 'Unknown'}${path.extname(resumeFile.originalname)}`
      const savePath = path.join(RESUME_FOLDER, safeName)
      fs.mkdirSync(RESUME_FOLDER, { recursive: true })
      fs.writeFileSync(savePath, resumeFile.buffer)
    }

    // Save to Google Sheets
    const sheets = getSheetsClient()
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: 'Sheet1!A:AB',
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [row] }
    })

    // Auto-reply to applicant
    const autoReplyBody = `Dear ${f.firstName},

Thank you for submitting your application to USNurse Direct!

We have received your pre-screening form and our team will review your information carefully. You can expect to hear from us within 2–3 business days to schedule your screening interview.

Here is a summary of what you submitted:
- Name: ${f.firstName} ${f.lastName}
- NCLEX Passed: ${f.nclex}
- Preferred States: ${[f.state1, f.state2, f.state3].filter(Boolean).join(', ')}
- Current Location: ${f.currentLocation}

What happens next?
1. Our team reviews your application
2. We match you with available direct hire positions
3. We contact you to schedule a screening interview
4. You get connected directly with the hiring facility

If you have any questions, feel free to reply to this email.

We look forward to helping you start your US nursing career!

Warm regards,
The USNurse Direct Team
careers@usnursedirect.global
www.usnursedirect.global`

    const careersGmail = getGmailClient(CAREERS_REFRESH_TOKEN)

    if (f.email && f.email.trim()) await careersGmail.users.messages.send({
      userId: 'me',
      requestBody: {
        raw: makeEmail({
          to: f.email.trim(),
          from: 'careers@usnursedirect.global',
          subject: 'Your USNurse Direct Application Has Been Received',
          body: autoReplyBody
        })
      }
    })

    // Notify careers team
    const notifyBody = `New application received from ${f.firstName} ${f.lastName}

Email: ${f.email}
Phone: ${f.phone}
Messenger: ${f.messenger}
Location: ${f.currentLocation}
Employer: ${f.currentEmployer}
NCLEX: ${f.nclex}
Priority Date: ${f.priorityDate} (${f.priorityDateStatus})
US License: ${f.usLicense}${f.usLicenseState ? ' - ' + f.usLicenseState : ''}
English Exam: ${f.englishExam}
Visa Screen: ${f.visaScreen}
Preferred States: ${[f.state1, f.state2, f.state3].filter(Boolean).join(', ')}
Family in US: ${f.familyInUS}${f.familyLocation ? ' - ' + f.familyLocation : ''}
Marital Status: ${f.maritalStatus} | Children: ${f.children}
Prior Contract: ${f.priorContract}
Preferred Contact: ${f.preferredContact}
Available: ${f.availableDays}

Nursing Experience:
${f.nursingExperience}

Resume: ${resumeFile ? resumeFile.originalname : 'Not provided'}

Submitted: ${date} ${time} CST`

    const notifyEmailRaw = resumeFile
      ? makeEmailWithAttachment({
          to: 'careers@usnursedirect.global',
          from: 'careers@usnursedirect.global',
          subject: `New Applicant: ${f.firstName} ${f.lastName}`,
          body: notifyBody,
          attachment: resumeFile
        })
      : makeEmail({
          to: 'careers@usnursedirect.global',
          from: 'careers@usnursedirect.global',
          subject: `New Applicant: ${f.firstName} ${f.lastName}`,
          body: notifyBody
        })

    await careersGmail.users.messages.send({
      userId: 'me',
      requestBody: { raw: notifyEmailRaw }
    })

    res.json({ success: true })
  } catch (err) {
    console.error('Error:', err.message)
    res.status(500).json({ success: false, error: err.message })
  }
})

app.get('/test-email', async (req, res) => {
  try {
    const careersGmail = getGmailClient(CAREERS_REFRESH_TOKEN)
    const raw = makeEmail({
      to: 'lexersandbox@gmail.com',
      from: 'careers@usnursedirect.global',
      subject: 'Test Email',
      body: 'This is a test.'
    })
    await careersGmail.users.messages.send({ userId: 'me', requestBody: { raw } })
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ success: false, error: err.message, stack: err.stack })
  }
})

app.get('/health', (req, res) => res.json({ status: 'ok' }))

const PORT = process.env.PORT || 3002
app.listen(PORT, () => console.log(`USNurse Direct backend running on port ${PORT}`))
