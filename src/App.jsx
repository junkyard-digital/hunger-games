import { useEffect, useState } from 'react';
import { supabase } from './lib/supabaseClient';
import './app.css';
import Location from './components/Location';



function App() {
  const [test, setTest] = useState([])

  useEffect(() => {
    getTest()
  }, [])

  async function getTest() {
    const { data, error } = await supabase.from('test').select()

    if (error) {
      console.error(error)
      return
    }

    setTest(data)
  }

  return (
    <>
    <Location></Location>
    <p></p>
    <ul>
      {test.map((one_test) => (
        <li key={one_test.id}>{one_test.id}</li>
      ))}
    </ul>
    </>
  )
}
export default App