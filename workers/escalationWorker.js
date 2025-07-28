const { Worker } = require('bullmq');
const Redis = require('ioredis');
const nodemailer = require('nodemailer');
const dayjs = require('dayjs');
const { createClient } = require('@supabase/supabase-js');

const connection = new Redis(process.env.REDIS_URL);
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const transporter = nodemailer.createTransport({
  host: process.env.MAIL_HOST,
  port: 465,
  secure: true,
  auth: {
    user: process.env.EMAIL_USERNAME,
    pass: process.env.EMAIL_PASSWORD,
  },
});

function generateICS(issue, newDueDate) {
  const startDate = dayjs(newDueDate).startOf('day').format('YYYYMMDD');
  const endDate = dayjs(newDueDate).add(1, 'day').startOf('day').format('YYYYMMDD');
  return `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//YourOrg//Issue Escalation//EN
CALSCALE:GREGORIAN
BEGIN:VEVENT
DTSTAMP:${dayjs().format('YYYYMMDDTHHmmss')}Z
DTSTART;VALUE=DATE:${startDate}
DTEND;VALUE=DATE:${endDate}
SUMMARY:Issue Escalation - ${issue.serialNumber}
DESCRIPTION:Escalation due date for issue ${issue.serialNumber}.\nPlease take necessary action before this date.
STATUS:CONFIRMED
SEQUENCE:0
UID:${issue.id}@yourdomain.com
END:VEVENT
END:VCALENDAR`;
}

new Worker('escalationQueue', async () => {
  const now = dayjs();
  let totalEmailsSent = 0;

  const { data: issues, error: issueError } = await supabase
    .from('Issue')
    .select('*')
    .eq('status', 'pending');

  if (issueError) throw issueError;

  for (const issue of issues || []) {
    if (!issue.dueDate) continue;

    const dueDate = dayjs(issue.dueDate);
    const sendDate = dueDate.add(1, 'day');
    if (!now.isSame(sendDate, 'day')) continue;

    const { data: escalation, error: escError } = await supabase
      .from('Escalation')
      .select('*')
      .eq('organizationId', issue.organizationId)
      .eq('id', issue.type);

    if (escError || !escalation || escalation.length === 0) continue;
    const escalationData = escalation[0];
    if (escalationData.facility?.value !== issue.type) continue;

    const escalationCategory = escalationData.categoryData;
    const categoryConfig = escalationCategory?.find(
      (c) => c.category === issue.category
    );
    if (!categoryConfig?.savedEntries?.[0]?.escalations?.length) continue;

    const escalations = categoryConfig.savedEntries[0].escalations;
    const currentLevel = issue.currentEscalationLevel || 0;
    const nextEscalation = escalations[currentLevel];
    if (!nextEscalation) continue;

    let recipients = nextEscalation.user || [];

    if (recipients.length === 0) {
      const { data: orgData } = await supabase
        .from('Organization')
        .select('groupEmail')
        .eq('id', issue.organizationId)
        .single();

      recipients = orgData?.groupEmail ? [orgData.groupEmail] : ['checkcitedb@gmail.com.ng'];
    }

    const isFinalLevel = currentLevel === escalations.length - 1;
    const escalationLevelNumber = currentLevel + 1;
    const newDueDate = isFinalLevel
      ? now.add(3, 'day').format('YYYY-MM-DD')
      : now.add(parseInt(escalations[currentLevel + 1]?.delay || '0'), 'day').format('YYYY-MM-DD');

    const actionNote = isFinalLevel
      ? `<p><strong>This is the final escalation level.</strong> Please resolve the issue by <strong>${newDueDate}</strong>.</p>`
      : `<p>Please take action before <strong>${newDueDate}</strong> to avoid further escalation.</p>`;

    const ccEmails = issue.inspectionAssignee?.name ? [issue.inspectionAssignee.name] : [];

    const icsContent = generateICS(issue, newDueDate);

    for (const email of recipients) {
      try {
        await transporter.sendMail({
          from: process.env.EMAIL_USERNAME,
          to: email,
          cc: ccEmails.join(','),
          subject: `🚨 Escalation Alert: Issue ${issue.serialNumber}`,
          html: `
            <div style="font-family: Arial, sans-serif;">
              <h2>Escalation Alert</h2>
              <p><strong>Issue:</strong> ${issue.serialNumber}</p>
              <p><strong>Category:</strong> ${issue.category}</p>
              <p><strong>Due Date:</strong> ${dueDate.format('YYYY-MM-DD')}</p>
              <p><strong>Escalation Level:</strong> ${escalationLevelNumber}</p>
              <p><strong>New Due Date:</strong> ${newDueDate}</p>
              ${actionNote}
            </div>
          `,
          alternatives: [
            {
              contentType: 'text/calendar; charset=UTF-8; method=REQUEST',
              content: icsContent,
            },
          ],
        });

        await supabase
          .from('Issue')
          .update({
            currentEscalationLevel: escalationLevelNumber,
            dueDate: newDueDate,
          })
          .eq('id', issue.id);

        console.log(`✅ Email sent for issue ${issue.serialNumber} to ${email}`);
        totalEmailsSent++;
        break;
      } catch (err) {
        console.error(`❌ Failed sending email to ${email}:`, err);
      }
    }
  }

  console.log(`🎉 Total escalation emails sent: ${totalEmailsSent}`);
}, { connection });
