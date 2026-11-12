import { createHmac, createHash, timingSafeEqual, randomBytes } from 'node:crypto';

export function createAuth(password = '', secure = false) {
  const sign = value => createHmac('sha256', password).update(value).digest('hex');
  const equal = (a, b) => timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
  return {
    required: Boolean(password), actionToken: password ? sign('courtside-csrf-v1') : randomBytes(24).toString('hex'),
    valid(request) {
      if (!password) return true;
      const cookie = /(?:^|;\s*)courtside_session=([^;]+)/.exec(request.headers.cookie ?? '')?.[1];
      if (!cookie) return false;
      const [expires, nonce, signature] = cookie.split('.');
      return Boolean(expires && nonce && signature && Number(expires) > Date.now() && equal(signature, sign(`${expires}.${nonce}`)));
    },
    login(value) {
      if (typeof value !== 'string' || !password || !equal(value, password)) return null;
      const payload = `${Date.now() + 12 * 3600000}.${randomBytes(16).toString('hex')}`;
      return `courtside_session=${payload}.${sign(payload)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${secure ? '; Secure' : ''}`;
    }
  };
}
