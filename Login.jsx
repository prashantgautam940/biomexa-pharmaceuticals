import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';

export default function Login() {
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    try {
      const fullPhone = phone.startsWith('+') ? phone : `+91${phone}`;
      const res = await fetch('http://localhost:5000/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: fullPhone, password })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || 'Login failed');
      localStorage.setItem('token', data.token);
      navigate('/dashboard');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{minHeight:'100vh',background:'#0f172a',display:'flex',alignItems:'center',justifyContent:'center',fontFamily:'system-ui,sans-serif'}}>
      <div style={{width:'100%',maxWidth:'420px',padding:'40px 24px'}}>
        <h1 style={{color:'#14b8a6',textAlign:'center',fontSize:'28px',margin:0}}>⚕️ Biomexa</h1>
        <p style={{color:'#94a3b8',textAlign:'center',marginBottom:'24px'}}>Sign in to manage your dose reminders</p>
        
        {error && <div style={{background:'rgba(239,68,68,0.1)',border:'1px solid rgba(239,68,68,0.3)',color:'#f87171',padding:'12px',borderRadius:'8px',marginBottom:'20px',fontSize:'14px'}}>⚠️ {error}</div>}
        
        <form onSubmit={handleSubmit}>
          <label style={{color:'#cbd5e1',fontSize:'14px',display:'block',marginBottom:'8px'}}>Phone Number *</label>
          <div style={{display:'flex',gap:'8px',marginBottom:'20px'}}>
            <div style={{background:'#1e293b',border:'1px solid #334155',borderRadius:'8px',padding:'12px 16px',color:'#cbd5e1'}}>🇮🇳 +91</div>
            <input type="tel" placeholder="9140339181" value={phone} onChange={e=>setPhone(e.target.value)} required style={{flex:1,background:'#1e293b',border:'1px solid #334155',borderRadius:'8px',padding:'12px 16px',color:'#f1f5f9',fontSize:'14px',outline:'none'}}/>
          </div>
          
          <label style={{color:'#cbd5e1',fontSize:'14px',display:'block',marginBottom:'8px'}}>Password *</label>
          <input type="password" placeholder="••••••" value={password} onChange={e=>setPassword(e.target.value)} required style={{width:'100%',background:'#1e293b',border:'1px solid #334155',borderRadius:'8px',padding:'12px 16px',color:'#f1f5f9',fontSize:'14px',outline:'none',marginBottom:'24px',boxSizing:'border-box'}}/>
          
          <button type="submit" disabled={loading} style={{width:'100%',background:'linear-gradient(135deg,#0d9488,#14b8a6)',color:'white',border:'none',borderRadius:'8px',padding:'14px',fontSize:'15px',fontWeight:'600',cursor:loading?'not-allowed':'pointer',opacity:loading?0.7:1}}>{loading?'Signing in...':'Sign In'}</button>
        </form>
        
        <div style={{display:'flex',alignItems:'center',gap:'16px',margin:'24px 0'}}><div style={{flex:1,height:'1px',background:'#334155'}}></div><span style={{color:'#64748b',fontSize:'13px'}}>or</span><div style={{flex:1,height:'1px',background:'#334155'}}></div></div>
        
        <p style={{color:'#94a3b8',textAlign:'center',fontSize:'14px',margin:0}}>Don't have an account? <Link to="/signup" style={{color:'#14b8a6',textDecoration:'none',fontWeight:'500'}}>Create Account</Link></p>
      </div>
    </div>
  );
}
