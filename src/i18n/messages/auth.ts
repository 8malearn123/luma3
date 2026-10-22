export const auth = {
  ar: {
    auth: {
      login_title: 'تسجيل الدخول', register_title: 'إنشاء حساب', identifier: 'البريد الإلكتروني أو رقم الجوال', identifier_hint: 'مثال: name@mail.com أو 05XXXXXXXX',
      display_name: 'اسمك', password_hint: '١٠ أحرف على الأقل', login_cta: 'دخول', register_cta: 'إنشاء الحساب', have_account: 'لديكِ حساب؟', no_account: 'ليس لديكِ حساب؟',
      forgot: 'نسيتِ كلمة المرور؟', verify_title: 'تأكيد الحساب', verify_sent: 'أرسلنا رمزاً من ٦ أرقام إلى {dest}.', code: 'رمز التحقق', verify_cta: 'تأكيد',
      resend: 'إعادة إرسال الرمز', recovery_title: 'استعادة كلمة المرور', recovery_hint: 'سنرسل رمزاً لإعادة تعيين كلمة المرور إذا كان الحساب موجوداً.',
      recovery_cta: 'إرسال الرمز', new_password: 'كلمة المرور الجديدة', reset_cta: 'تعيين كلمة المرور', reset_done: 'تم تغيير كلمة المرور. سجّلي الدخول من جديد.',
      dev_code_label: 'وضع التطوير — لم تُرسل أي رسالة فعلية. الرمز هو:',
      delivery_unavailable: 'لا يوجد مزوّد رسائل متصل؛ لم يُرسل الرمز.',
      sessions_title: 'الأجهزة المسجّلة', this_device: 'هذا الجهاز', revoke: 'إنهاء الجلسة', revoke_others: 'تسجيل الخروج من الأجهزة الأخرى',
      reauth_title: 'تأكيد الهوية', reauth_hint: 'لحماية حسابك، أكّدي كلمة المرور قبل هذا الإجراء.',
      demo_title: 'تبديل الأدوار (عرض تجريبي خاص)', demo_hint: 'متاح فقط في بيئة المراجعة الخاصة، ومعطّل في الإنتاج.',
      invite_title: 'دعوة للانضمام', invite_accept: 'قبول الدعوة', invite_signin: 'سجّلي الدخول بالبريد أو الجوال الذي وصلته الدعوة.',
    },
  },
  en: {
    auth: {
      login_title: 'Sign in', register_title: 'Create account', identifier: 'Email or mobile number', identifier_hint: 'e.g. name@mail.com or 05XXXXXXXX',
      display_name: 'Your name', password_hint: 'At least 10 characters', login_cta: 'Sign in', register_cta: 'Create account', have_account: 'Have an account?', no_account: "Don't have an account?",
      forgot: 'Forgot password?', verify_title: 'Verify your account', verify_sent: 'We sent a 6-digit code to {dest}.', code: 'Verification code', verify_cta: 'Verify',
      resend: 'Resend code', recovery_title: 'Reset password', recovery_hint: 'We will send a reset code if the account exists.',
      recovery_cta: 'Send code', new_password: 'New password', reset_cta: 'Set password', reset_done: 'Password changed. Please sign in again.',
      dev_code_label: 'Development mode — no real message was sent. The code is:',
      delivery_unavailable: 'No messaging provider is connected; the code was not sent.',
      sessions_title: 'Signed-in devices', this_device: 'This device', revoke: 'End session', revoke_others: 'Sign out of other devices',
      reauth_title: 'Confirm it is you', reauth_hint: 'To protect your account, confirm your password before this action.',
      demo_title: 'Role switcher (private demo)', demo_hint: 'Available only in the private review environment; disabled in production.',
      invite_title: 'Invitation', invite_accept: 'Accept invitation', invite_signin: 'Sign in with the email or phone the invitation was sent to.',
    },
  },
};
