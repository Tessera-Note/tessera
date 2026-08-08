import { rem } from '@mantine/core';

interface Props {
  size?: number | string;
}

export function GoogleSlidesIcon({ size }: Props) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 48 48"
      style={{ width: rem(size), height: rem(size) }}
    >
      <path
        fill="#ffa000"
        d="M37,45H11c-1.657,0-3-1.343-3-3V6c0-1.657,1.343-3,3-3h19l10,10v29C40,43.657,38.657,45,37,45z"
      />
      <path fill="#ffe0b2" d="M40 13L30 13 30 3z" />
      <path fill="#ef6c00" d="M30 13L40 23 40 13z" />
      <path fill="#fff8e1" d="M15 23H33V37H15z" />
      <path fill="#ffa000" d="M17 25H31V35H17z" />
    </svg>
  );
}
