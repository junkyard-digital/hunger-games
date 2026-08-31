import { useEffect, useState } from 'react';
import { supabase } from './lib/supabaseClient';
import './styles.css';
import Location from './components/Location';
import Map from './components/Map';



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
    <Map></Map>
    {/* <ul>
      {test.map((one_test) => (
        <li key={one_test.id}>{one_test.id}</li>
      ))}
    </ul> */}
    </>
  )
}
export default App