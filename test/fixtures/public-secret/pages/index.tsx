export default function Home() {
  return <div>{process.env.STRIPE_SECRET_KEY}</div>;
}
