'use strict';

// Deterministic baseline data for TEST-DATA.md. Personal identifiers are only
// stored encrypted; the deliberately invalid Thai ID is rejected by auth code.
module.exports = function seed(db, helpers) {
  const { encrypt, idHash } = helpers;
  const now = '2026-12-01T09:00:00+07:00';
  const staff = require('../lib/session');
  const addUser = db.prepare(`INSERT INTO users(role,username,password_hash,name,dept,id_hash,id_enc,mobile_enc,email,registered,consent_at,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`);
  const citizens = [
    ['สมชาย ใจดี','1101700123456','0812345678',1],
    ['สมหญิง รักไทย','3100600987659','0823456789',1],
    ['มานะ ตั้งใจ','5500400111221',null,0],
    ['ปิติ มีสุข','1909900555015','0834567890',1],
  ];
  for (const [name,id,mobile,registered] of citizens) addUser.run('citizen',null,null,name,'',idHash(id),encrypt(id),encrypt(mobile),'',registered,registered?now:null,now);
  const employees = [
    ['off.reg1','เจ้าหน้าที่ทะเบียน 1','officer','registry'],['off.reg2','เจ้าหน้าที่ทะเบียน 2','officer','registry'],
    ['off.works1','เจ้าหน้าที่โยธา 1','officer','works'],['head1','หัวหน้าฝ่าย','head',''],
    ['exec1','ผู้บริหาร','executive',''],['audit1','ผู้ตรวจสอบภายใน','auditor',''],['admin1','ผู้ดูแลระบบ','admin',''],
  ];
  for (const [username,name,role,dept] of employees) addUser.run(role,username,staff.hashPassword('Test@1234'),name,dept,null,null,null,'',1,now,now);
  const uid = Object.fromEntries(db.prepare("SELECT id,name FROM users WHERE role='citizen'").all().map(x=>[x.name,x.id]));

  db.prepare('INSERT INTO services(id,name,fee,fee_per_sqm,sla,sort) VALUES(?,?,?,?,?,?)').run('SV-01','ขอหนังสือรับรอง',20,0,3,1);
  db.prepare('INSERT INTO services(id,name,fee,fee_per_sqm,sla,sort) VALUES(?,?,?,?,?,?)').run('SV-02','ขออนุญาตประกอบกิจการ',500,0,10,2);
  db.prepare('INSERT INTO services(id,name,fee,fee_per_sqm,sla,sort) VALUES(?,?,?,?,?,?)').run('SV-03','ขออนุญาตก่อสร้าง/ต่อเติมอาคาร',1000,10,15,3);
  const hol = db.prepare('INSERT INTO holidays(date,name) VALUES(?,?)');
  [['2026-12-07','ชดเชยวันหยุดทดสอบ (สมมติ)'],['2026-12-10','วันรัฐธรรมนูญทดสอบ (สมมติ)'],['2026-12-31','วันสิ้นปีทดสอบ (สมมติ)'],['2027-01-01','วันขึ้นปีใหม่ทดสอบ (สมมติ)']].forEach(x=>hol.run(...x));

  // index, service, applicant, status, quantity/area, fee, due, paid, dept, owner, step, close, extras
  const rows = [
    [1,'SV-01','สมหญิง รักไทย','COMPLETED',1,20,'2026-10-19T16:30:00+07:00','2026-10-14T10:00:00+07:00',null,null,null,'2026-10-16T14:00:00+07:00'],
    [2,'SV-03','ปิติ มีสุข','COMPLETED',null,1200,'2026-11-23T16:30:00+07:00','2026-11-02T09:00:00+07:00',null,null,null,'2026-11-20T11:00:00+07:00'],
    [3,'SV-01','ปิติ มีสุข','COMPLETED',2,40,'2026-11-05T16:30:00+07:00','2026-11-02T09:30:00+07:00',null,null,null,'2026-11-04T15:00:00+07:00'],
    [4,'SV-02','สมชาย ใจดี','COMPLETED',null,500,'2026-11-16T16:30:00+07:00','2026-11-02T14:00:00+07:00',null,null,null,'2026-11-13T15:00:00+07:00'],
    [5,'SV-01','สมชาย ใจดี','COMPLETED',1,20,'2026-11-06T16:30:00+07:00','2026-11-03T11:00:00+07:00',null,null,null,'2026-11-05T10:00:00+07:00',{issuer:'off.reg1'}],
    [6,'SV-02','ปิติ มีสุข','COMPLETED',null,500,'2026-11-17T16:30:00+07:00','2026-11-03T15:00:00+07:00',null,null,null,'2026-11-19T10:00:00+07:00'],
    [7,'SV-02','สมหญิง รักไทย','COMPLETED',null,500,'2026-11-18T16:30:00+07:00','2026-11-04T10:00:00+07:00',null,null,null,'2026-11-18T16:00:00+07:00'],
    [8,'SV-01','สมหญิง รักไทย','REJECTED',1,20,'2026-11-12T16:30:00+07:00','2026-11-09T10:00:00+07:00',null,null,null,'2026-11-11T09:00:00+07:00'],
    [9,'SV-01','สมชาย ใจดี','CANCELLED',1,20,'2026-11-12T16:30:00+07:00','2026-11-09T14:30:00+07:00',null,null,null,null,{cancelled:'2026-11-09T15:00:00+07:00'}],
    [10,'SV-03','สมหญิง รักไทย','IN_REVIEW',null,1000,'2026-12-03T16:30:00+07:00','2026-11-12T10:00:00+07:00','works',null,2],
    [11,'SV-03','สมชาย ใจดี','PENDING_APPROVAL',null,1500,'2026-12-08T16:30:00+07:00','2026-11-16T10:00:00+07:00',null,null,3,null,{issuer:'off.reg1'}],
    [12,'SV-03','ปิติ มีสุข','IN_REVIEW',null,1010,'2026-12-11T16:30:00+07:00','2026-11-18T10:00:00+07:00','registry','off.reg2',1],
    [13,'SV-02','สมชาย ใจดี','IN_REVIEW',null,500,'2026-12-04T16:30:00+07:00','2026-11-20T10:00:00+07:00','registry','off.reg2'],
    [14,'SV-02','ปิติ มีสุข','PENDING_APPROVAL',null,500,'2026-12-04T16:30:00+07:00','2026-11-20T11:00:00+07:00',null,null,null,null,{issuer:'off.reg1'}],
    [15,'SV-02','สมหญิง รักไทย','IN_REVIEW',null,500,'2026-12-04T16:30:00+07:00','2026-11-20T15:00:00+07:00','registry','off.reg2'],
    [16,'SV-02','ปิติ มีสุข','IN_REVIEW',null,500,'2026-12-08T16:30:00+07:00','2026-11-23T09:00:00+07:00','registry','off.reg2'],
    [17,'SV-01','สมชาย ใจดี','NEED_FIX',1,20,'2026-11-27T16:30:00+07:00','2026-11-23T10:00:00+07:00','registry','off.reg1',null,null,{returns:2,returned:'2026-11-27T14:00:00+07:00',fix:'2026-12-04T14:00:00+07:00',reason:'ชื่อในเอกสารไม่ตรงกับบัตร กรุณาแก้ไข'}],
    [18,'SV-02','สมชาย ใจดี','IN_REVIEW',null,500,'2026-12-09T16:30:00+07:00','2026-11-24T10:00:00+07:00','registry','off.reg2'],
    [19,'SV-02','สมหญิง รักไทย','APPROVED',null,500,'2026-12-09T16:30:00+07:00','2026-11-24T14:00:00+07:00',null,null,null,null,{issuer:'off.reg1',approved:'2026-11-30T15:00:00+07:00'}],
    [20,'SV-01','สมชาย ใจดี','IN_REVIEW',1,20,'2026-11-30T16:30:00+07:00','2026-11-25T10:00:00+07:00','registry','off.reg1'],
    [21,'SV-02','สมหญิง รักไทย','IN_REVIEW',null,500,'2026-12-11T16:30:00+07:00','2026-11-25T12:00:00+07:00','registry','off.reg2'],
    [22,'SV-01','สมหญิง รักไทย','IN_REVIEW',2,40,'2026-12-01T16:30:00+07:00','2026-11-26T10:00:00+07:00','registry','off.reg1'],
    [23,'SV-01','สมหญิง รักไทย','IN_REVIEW',1,20,'2026-12-03T16:30:00+07:00','2026-11-26T10:30:00+07:00','registry','off.reg1',null,null,{returns:2,returned:'2026-12-01T08:30:00+07:00'}],
    [24,'SV-01','ปิติ มีสุข','SUBMITTED',1,20,'2026-12-02T16:30:00+07:00','2026-11-27T11:00:00+07:00','registry',null],
    [25,'SV-01','สมหญิง รักไทย','IN_REVIEW',3,60,'2026-12-03T16:30:00+07:00','2026-11-30T10:00:00+07:00','registry','off.reg2'],
    [26,'SV-01','สมชาย ใจดี','IN_REVIEW',5,100,'2026-12-03T16:30:00+07:00','2026-11-30T16:29:00+07:00','registry','off.reg2'],
    [27,'SV-01','ปิติ มีสุข','IN_REVIEW',1,20,'2026-12-04T16:30:00+07:00','2026-11-30T16:30:00+07:00','registry','off.reg2'],
    [28,'SV-01','สมหญิง รักไทย','SUBMITTED',1,20,'2026-12-04T16:30:00+07:00','2026-12-01T08:10:00+07:00','registry',null],
    [29,'SV-01','ปิติ มีสุข','SUBMITTED',1,20,'2026-12-04T16:30:00+07:00','2026-12-01T08:20:00+07:00','registry',null],
    [30,'SV-01','สมชาย ใจดี','SUBMITTED',1,20,'2026-12-04T16:30:00+07:00','2026-12-01T08:30:00+07:00','registry',null],
  ];
  const putCase = db.prepare(`INSERT INTO cases(case_no,receipt_no,service_id,applicant_id,status,qty,area_sqm,fee,step,dept,owner,issuer,approved_by,approved_at,return_count,returned_at,fix_deadline,return_reason,paid_at,due_at,closed_at,cancelled_at,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const caseIds={};
  for (const r of rows) {
    const [n,service,person,status,qOrArea,fee,due,paid,dept,owner,step,closed,extra={}] = r;
    const caseNo=`EG-2569-${String(n).padStart(6,'0')}`, receipt=`RC-2569-${String(n).padStart(6,'0')}`;
    const area=service==='SV-03'?qOrArea:null, qty=service==='SV-01'?qOrArea:null;
    const issuer=extra.issuer || (service==='SV-03' && n===10 ? 'off.reg1' : null);
    const approved=extra.approved || null;
    putCase.run(caseNo,receipt,service,uid[person],status,qty,area,fee,step,dept,owner,issuer,approved?'head1':null,approved,extra.returns||0,extra.returned||null,extra.fix||null,extra.reason||null,paid,due,closed||null,extra.cancelled||null,paid,now);
    caseIds[n]=db.prepare('SELECT id FROM cases WHERE case_no=?').get(caseNo).id;
    db.prepare('INSERT INTO payments(ref,case_id,amount,status,qr_created_at,qr_expires_at,paid_at) VALUES(?,?,?,?,?,?,?)').run(`PS-${String(n).padStart(4,"0")}`,caseIds[n],fee,'PAID',paid,paid,paid);
    if (status==='CANCELLED') db.prepare('INSERT INTO case_events(case_id,at,actor,event,from_status,to_status,note) VALUES(?,?,?,?,?,?,?)').run(caseIds[n],extra.cancelled,'citizen','CANCEL','SUBMITTED','CANCELLED','');
    if (extra.returns) seedReturns(db,caseIds[n],n);
    const keys=service==='SV-01'?['id-card']:service==='SV-02'?['id-card','map']:['id-card','plan','deed'];
    for (const key of keys) db.prepare('INSERT INTO files(id,case_id,doc_key,name,mime,size,content,uploaded_at,uploaded_by) VALUES(?,?,?,?,?,?,?,?,?)').run(`SEED-${String(n).padStart(3,'0')}-${key}`,caseIds[n],key,({ 'id-card':'id-card.pdf',map:'map.pdf',plan:'plan.pdf',deed:'deed.pdf'})[key],'application/pdf',1024,seedPdf(),paid,'citizen');
  }
  // Two citizen drafts; files for the pending-payment draft are complete.
  db.prepare(`INSERT INTO cases(draft_id,service_id,applicant_id,status,qty,fee,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)`).run('DR-0001','SV-01',uid['สมชาย ใจดี'],'DRAFT',2,40,now,now);
  const draftId=db.prepare(`INSERT INTO cases(draft_id,service_id,applicant_id,status,fee,created_at,updated_at) VALUES(?,?,?,?,?,?,?)`).run('DR-0002','SV-02',uid['สมชาย ใจดี'],'PENDING_PAYMENT',500,now,now).lastInsertRowid;
  for (const key of ['id-card','map']) db.prepare('INSERT INTO files(id,case_id,doc_key,name,mime,size,content,uploaded_at,uploaded_by) VALUES(?,?,?,?,?,?,?,?,?)').run(`DR2-${key}`,draftId,key,key==='map'?'map.pdf':'id-card.pdf','application/pdf',1024,seedPdf(),now,'citizen');
  db.prepare('INSERT INTO payments(ref,case_id,amount,status,qr_created_at,qr_expires_at) VALUES(?,?,?,?,?,?)').run('PP-0001',draftId,500,'PENDING','2026-12-01T08:55:00+07:00','2026-12-01T09:10:00+07:00');

  // The one pre-existing issued document, with a real HMAC signature.
  const docNo='DOC-2569-000001', caseNo='EG-2569-000005', applicant='สมชาย ใจดี', serviceId='SV-01';
  const issued='2026-11-05T10:00:00+07:00', valid='2027-02-02', signer='เจ้าหน้าที่ทะเบียน 1';
  const signature=require('crypto').createHmac('sha256',process.env.SIGN_KEY||'egov-eservice-test-sign-key').update([docNo,caseNo,applicant,serviceId,issued,valid,signer].join('|')).digest('hex');
  db.prepare(`INSERT INTO documents(doc_no,case_id,case_no,applicant,service_id,issued_at,valid_until,signer,verify_code,signature,issued_by) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(docNo,caseIds[5],caseNo,applicant,serviceId,issued,valid,signer,'K7M2Q9XA',signature,'off.reg1');

  // Sequence high water marks: generated IDs after reset match TEST-DATA.
  db.prepare('INSERT INTO counters(name,value) VALUES(?,?)').run('draft',2);
  db.prepare('INSERT INTO counters(name,value) VALUES(?,?)').run('payment',1);
  db.prepare('INSERT INTO counters(name,value) VALUES(?,?)').run('case:2569',30);
  db.prepare('INSERT INTO counters(name,value) VALUES(?,?)').run('doc:2569',1);
};

function seedPdf(){ return Buffer.concat([Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n'),Buffer.alloc(960,32),Buffer.from('\ntrailer<</Root 1 0 R>>\n%%EOF\n')]).subarray(0,1024); }
function seedReturns(db,id,n){
  const ins=db.prepare('INSERT INTO case_returns(case_id,n,returned_at,returned_by,reason,resubmitted_at,paused_days) VALUES(?,?,?,?,?,?,?)');
  const ev=db.prepare('INSERT INTO case_events(case_id,at,actor,event,from_status,to_status,note) VALUES(?,?,?,?,?,?,?)');
  const pairs=n===17?[
    [1,'2026-11-24T11:00:00+07:00','off.reg1','ภาพบัตรประชาชนไม่ชัด กรุณาถ่ายใหม่','2026-11-25T10:00:00+07:00',1],
    [2,'2026-11-27T14:00:00+07:00','off.reg1','ชื่อในเอกสารไม่ตรงกับบัตร กรุณาแก้ไข',null,null],
  ]:[
    [1,'2026-11-27T10:00:00+07:00','off.reg1','ภาพเอกสารเบลอ อ่านเลขไม่ได้','2026-11-30T10:00:00+07:00',1],
    [2,'2026-11-30T14:00:00+07:00','off.reg1','ข้อมูลในแบบฟอร์มไม่ครบถ้วน','2026-12-01T08:30:00+07:00',1],
  ];
  for(const p of pairs){ins.run(id,...p);ev.run(id,p[1],p[2],'RETURN',p[0]===1?'IN_REVIEW':'IN_REVIEW','NEED_FIX',p[3]);if(p[4])ev.run(id,p[4],'citizen','RESUBMIT','NEED_FIX','IN_REVIEW','');}
}
