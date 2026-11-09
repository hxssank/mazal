import { useId } from 'react';

export default function MazalMark() {
  const id = useId();
  return <svg className="mazal-mark" viewBox="0 0 40 40" fill="none" aria-hidden="true" focusable="false">
    <defs>
      <linearGradient id={`${id}-base`} x1="5" y1="2" x2="35" y2="40" gradientUnits="userSpaceOnUse">
        <stop stopColor="#b9f5e6" stopOpacity=".2"/><stop offset="1" stopColor="#bda4ef" stopOpacity=".08"/>
      </linearGradient>
      <linearGradient id={`${id}-mint`} x1="8" y1="8" x2="22" y2="31" gradientUnits="userSpaceOnUse">
        <stop stopColor="#e0fff4"/><stop offset="1" stopColor="#89dcca"/>
      </linearGradient>
      <linearGradient id={`${id}-lilac`} x1="22" y1="10" x2="33" y2="30" gradientUnits="userSpaceOnUse">
        <stop stopColor="#e5e4ff"/><stop offset="1" stopColor="#ae9cdd"/>
      </linearGradient>
    </defs>
    <rect x=".75" y=".75" width="38.5" height="38.5" rx="12" fill={`url(#${id}-base)`} stroke="#d7f7ee" strokeOpacity=".28"/>
    <path d="M8 29V11l5-3 7 13v10l-7-12v10H8Z" fill={`url(#${id}-mint)`}/>
    <path d="m20 21 7-13 5 3v18h-5V19l-7 12V21Z" fill={`url(#${id}-lilac)`}/>
    <path d="m8 11 5-3 7 13 7-13 5 3" stroke="#f0fff9" strokeOpacity=".55" strokeWidth=".75" strokeLinejoin="round"/>
  </svg>;
}
